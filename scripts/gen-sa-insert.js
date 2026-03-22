#!/usr/bin/env node
// Genera el SQL para insertar Service Account en Supabase
// Uso: node scripts/gen-sa-insert.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const j = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
if (!j) {
  console.error('Falta GOOGLE_SERVICE_ACCOUNT_JSON en .env');
  process.exit(1);
}
const escaped = j.replace(/'/g, "''");
console.log("-- Copia y ejecuta en Supabase SQL Editor:");
console.log("insert into service_account_creds (id, json_data) values ('default', '" + escaped + "'::jsonb)");
console.log("on conflict (id) do update set json_data = excluded.json_data, updated_at = now();");
