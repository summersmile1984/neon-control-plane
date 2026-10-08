-- Official Endpoint.name (optional, 1..64 chars, settable on create and update).
-- Without the column the API accepted the field and silently dropped it, so a client that named an
-- endpoint read back null. See spec/neon-api-v2.json#/components/schemas/Endpoint.
ALTER TABLE endpoints ADD COLUMN name TEXT;