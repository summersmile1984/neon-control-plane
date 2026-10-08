import { Agent, request } from 'undici';

/**
 * Docker Engine API over the unix socket (002 §7.3). Only the calls the reconciler needs; no
 * dockerode, so the dependency surface stays small.
 */

export interface ContainerSpec {
  readonly name: string;
  readonly image: string;
  readonly cmd: readonly string[];
  readonly env?: readonly string[];
  readonly binds: readonly string[];
  readonly network: string;
  /** container port (e.g. '55433/tcp') -> host port */
  readonly portBindings: Readonly<Record<string, number>>;
  readonly labels: Readonly<Record<string, string>>;
  readonly entrypoint?: readonly string[];
}

export interface ContainerInfo {
  readonly id: string;
  readonly name: string;
  readonly running: boolean;
  readonly exitCode?: number;
  readonly labels: Record<string, string>;
}

export class DockerError extends Error {
  public readonly status: number | undefined;
  public constructor(message: string, status?: number) {
    super(message);
    this.name = 'DockerError';
    this.status = status;
  }
}

export interface DockerClient {
  ping(): Promise<boolean>;
  ensureNetwork(name: string): Promise<void>;
  /** Creates the container, or returns the existing one with that name (idempotent step). */
  createContainer(spec: ContainerSpec): Promise<{ id: string; created: boolean }>;
  startContainer(idOrName: string): Promise<void>;
  stopContainer(idOrName: string, timeoutSeconds?: number): Promise<void>;
  removeContainer(idOrName: string, force?: boolean): Promise<void>;
  inspect(idOrName: string): Promise<ContainerInfo | undefined>;
  listByLabel(label: string, value?: string): Promise<ContainerInfo[]>;
  /**
   * Every host port currently published by a container on this Docker host, mapped to the container
   * name. A published port is the compute's identity from the reconciler's point of view, so the
   * allocator has to know what else is holding ports before it binds one.
   */
  publishedPorts(): Promise<Map<number, string>>;
  logs(idOrName: string, tail?: number): Promise<string>;
}

export interface DockerClientOptions {
  readonly socketPath: string;
  readonly timeoutMs?: number;
}

export function createDockerClient(options: DockerClientOptions): DockerClient {
  const agent = new Agent({ connect: { socketPath: options.socketPath } });
  const timeout = options.timeoutMs ?? 60_000;

  async function call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, acceptStatuses: number[] = []): Promise<{ status: number; body: T }> {
    let response;
    try {
      response = await request(`http://localhost${path}`, {
        method,
        dispatcher: agent,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        headersTimeout: timeout,
        bodyTimeout: timeout,
      });
    } catch (cause) {
      throw new DockerError(`docker ${method} ${path} failed: ${String(cause)}`);
    }
    const text = await response.body.text();
    if (response.statusCode >= 400 && !acceptStatuses.includes(response.statusCode)) {
      throw new DockerError(`docker ${method} ${path} -> ${response.statusCode} ${text.slice(0, 300)}`, response.statusCode);
    }
    return { status: response.statusCode, body: (text ? JSON.parse(text) : undefined) as T };
  }

  const toInfo = (raw: {
    Id: string; Name?: string; Names?: string[]; State?: { Running?: boolean; ExitCode?: number } | string;
    Config?: { Labels?: Record<string, string> }; Labels?: Record<string, string>;
  }): ContainerInfo => {
    const state = raw.State;
    const running = typeof state === 'string' ? state === 'running' : Boolean(state?.Running);
    const info: ContainerInfo = {
      id: raw.Id,
      name: (raw.Name ?? raw.Names?.[0] ?? '').replace(/^\//, ''),
      running,
      labels: raw.Config?.Labels ?? raw.Labels ?? {},
    };
    const exitCode = typeof state === 'object' ? state?.ExitCode : undefined;
    return exitCode === undefined ? info : { ...info, exitCode };
  };

  return {
    async ping() {
      // `/_ping` answers the plain string `OK`, so it cannot go through the JSON path.
      try {
        const response = await request('http://localhost/_ping', {
          method: 'GET', dispatcher: agent, headersTimeout: timeout, bodyTimeout: timeout,
        });
        await response.body.text();
        return response.statusCode < 400;
      } catch {
        return false;
      }
    },

    async ensureNetwork(name) {
      const { status } = await call('GET', `/networks/${encodeURIComponent(name)}`, undefined, [404]);
      if (status === 404) await call('POST', '/networks/create', { Name: name, Driver: 'bridge' }, [409]);
    },

    async createContainer(spec) {
      const existing = await this.inspect(spec.name);
      if (existing) return { id: existing.id, created: false };
      const payload = {
        Image: spec.image,
        Cmd: [...spec.cmd],
        ...(spec.entrypoint ? { Entrypoint: [...spec.entrypoint] } : {}),
        Env: [...(spec.env ?? [])],
        Labels: { ...spec.labels },
        ExposedPorts: Object.fromEntries(Object.keys(spec.portBindings).map((port) => [port, {}])),
        HostConfig: {
          Binds: [...spec.binds],
          NetworkMode: spec.network,
          PortBindings: Object.fromEntries(
            Object.entries(spec.portBindings).map(([port, hostPort]) => [port, [{ HostIp: '127.0.0.1', HostPort: String(hostPort) }]]),
          ),
          RestartPolicy: { Name: 'no' },
        },
        NetworkingConfig: { EndpointsConfig: { [spec.network]: { Aliases: [spec.name] } } },
      };
      const { body } = await call<{ Id: string }>('POST', `/containers/create?name=${encodeURIComponent(spec.name)}`, payload);
      return { id: body.Id, created: true };
    },

    async startContainer(idOrName) {
      // 304 means "already started", which is success for an idempotent step.
      await call('POST', `/containers/${encodeURIComponent(idOrName)}/start`, undefined, [304]);
    },

    async stopContainer(idOrName, timeoutSeconds = 10) {
      await call('POST', `/containers/${encodeURIComponent(idOrName)}/stop?t=${timeoutSeconds}`, undefined, [304, 404]);
    },

    async removeContainer(idOrName, force = true) {
      await call('DELETE', `/containers/${encodeURIComponent(idOrName)}?force=${force ? 'true' : 'false'}&v=true`, undefined, [404, 409]);
    },

    async inspect(idOrName) {
      const { status, body } = await call<Parameters<typeof toInfo>[0]>('GET', `/containers/${encodeURIComponent(idOrName)}/json`, undefined, [404]);
      return status === 404 ? undefined : toInfo(body);
    },

    async listByLabel(label, value) {
      const filter = encodeURIComponent(JSON.stringify({ label: [value === undefined ? label : `${label}=${value}`] }));
      const { body } = await call<Array<Parameters<typeof toInfo>[0]>>('GET', `/containers/json?all=true&filters=${filter}`);
      return body.map(toInfo);
    },

    async publishedPorts() {
      type Listed = { Names?: string[]; Ports?: Array<{ PublicPort?: number }> };
      const { body } = await call<Listed[]>('GET', '/containers/json?all=true');
      const ports = new Map<number, string>();
      for (const container of body) {
        const name = (container.Names?.[0] ?? '').replace(/^\//, '');
        for (const port of container.Ports ?? []) {
          if (typeof port.PublicPort === 'number') ports.set(port.PublicPort, name);
        }
      }
      return ports;
    },

    async logs(idOrName, tail = 50) {
      try {
        const response = await request(`http://localhost/containers/${encodeURIComponent(idOrName)}/logs?stdout=true&stderr=true&tail=${tail}`, {
          method: 'GET', dispatcher: agent, headersTimeout: timeout, bodyTimeout: timeout,
        });
        const raw = Buffer.from(await response.body.arrayBuffer());
        // Docker multiplexes non-TTY logs with an 8-byte header per frame; strip them.
        const chunks: string[] = [];
        let offset = 0;
        while (offset + 8 <= raw.length) {
          const length = raw.readUInt32BE(offset + 4);
          chunks.push(raw.subarray(offset + 8, offset + 8 + length).toString('utf8'));
          offset += 8 + length;
        }
        return chunks.length > 0 ? chunks.join('') : raw.toString('utf8');
      } catch (cause) {
        return `unavailable: ${String(cause)}`;
      }
    },
  };
}
