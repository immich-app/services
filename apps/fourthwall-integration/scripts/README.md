# Product Keys Import Script

This script converts CSV files containing product keys into SQL INSERT statements for the D1 database.

## CSV Format

Your CSV files should have two columns:
1. License Key (the short product key)
2. Activation Key (the long activation key)

**Example CSV:**
```csv
license_key,activation_key
IMSV-V9W4-CVV5-6VE3-9G6U-RFUA-P747-39DM-3Q74,IYiqy7A_GzS3ybBDAKDXXrLNyWMQj44hovSCzYrw8qqadL-OLhCoV8en342BIxhtv2txHOYsToBMSiduzKzAsXKT88kJDiQRrp435O86w39xPue61sDgZbLJeVqsiiRqXDGtaIVfiLS7l8mZqYLPTarSYf__4i8bmkMB6HUnS067S3IHsyY9pcc7X050_MN24-x2JRQimH9wGJhzZ-guwzcD6LLjuOROGofSJkqvXD_HJNyJo0ekDjSKwuPbAcE4ozPSOUenDkUI0pFXyacl4qfsf8k5y1fElyXZ3vwhN9UJlfIEeQpmNH5tB3U_11_inQe6zXBPewo0rnFGSDTBqQ
IMCL-AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH,shortActivationKeyExample123
```

**Note:** The header row is optional - the script will auto-detect and skip it.

## Usage

### 1. Prepare your CSV files

Create two CSV files:
- `client-keys.csv` - Contains client product keys
- `server-keys.csv` - Contains server product keys

### 2. Run the script

```bash
cd apps/fourthwall-integration
npx ts-node scripts/import-product-keys.ts path/to/client-keys.csv path/to/server-keys.csv
```

### 3. Import into D1 database

The script will generate two separate SQL files in your current directory:
- `client-keys-import.sql` - Contains client product keys
- `server-keys-import.sql` - Contains server product keys

**Option A: Using Wrangler CLI**
```bash
wrangler d1 execute DB --file=client-keys-import.sql
wrangler d1 execute DB --file=server-keys-import.sql
```

**Option B: Using Cloudflare Dashboard**
1. Go to your Cloudflare dashboard
2. Navigate to Workers & Pages > D1
3. Select your database
4. Go to the Console tab
5. Copy and paste the SQL from `client-keys-import.sql`
6. Execute the query
7. Repeat with `server-keys-import.sql`

## Example

```bash
# Create example CSV files (optional)
cat > client-keys.csv << 'EOF'
license_key,activation_key
CLIENT-KEY-001,activation_client_001_long_string
CLIENT-KEY-002,activation_client_002_long_string
EOF

cat > server-keys.csv << 'EOF'
license_key,activation_key
SERVER-KEY-001,activation_server_001_long_string
SERVER-KEY-002,activation_server_002_long_string
EOF

# Run the import script
npx ts-node scripts/import-product-keys.ts client-keys.csv server-keys.csv

# Output:
# [INFO] Parsing CSV files...
# [INFO] Found 2 client keys
# [INFO] Found 2 server keys
# [INFO] Total keys: 4
# [INFO] Generating SQL INSERT statements...
# [SUCCESS] Client keys SQL written to: client-keys-import.sql
# [SUCCESS] Server keys SQL written to: server-keys-import.sql
```

## Output Format

The generated SQL files will contain individual INSERT statements:

**client-keys-import.sql:**
```sql
INSERT INTO product_keys (key_value, activation_key, key_type, is_claimed, created_at) VALUES ('CLIENT-KEY-001', 'activation_client_001_long_string', 'client', FALSE, '2025-01-27T22:15:00.000Z');
INSERT INTO product_keys (key_value, activation_key, key_type, is_claimed, created_at) VALUES ('CLIENT-KEY-002', 'activation_client_002_long_string', 'client', FALSE, '2025-01-27T22:15:00.000Z');
```

**server-keys-import.sql:**
```sql
INSERT INTO product_keys (key_value, activation_key, key_type, is_claimed, created_at) VALUES ('SERVER-KEY-001', 'activation_server_001_long_string', 'server', FALSE, '2025-01-27T22:15:00.000Z');
INSERT INTO product_keys (key_value, activation_key, key_type, is_claimed, created_at) VALUES ('SERVER-KEY-002', 'activation_server_002_long_string', 'server', FALSE, '2025-01-27T22:15:00.000Z');
```

## Troubleshooting

### "File not found" error
Make sure you're providing the correct path to your CSV files. Use absolute paths or paths relative to your current directory.

### "No valid keys found" error
Check that your CSV files:
- Have two columns per line
- Use comma (`,`) as the separator
- Don't have empty lines in the middle
- Have valid key values (not empty)

### Special characters in keys
The script automatically escapes single quotes in keys. Other special characters should work fine.

## Notes

- All keys are marked as `is_claimed = FALSE` by default (unclaimed)
- The `created_at` timestamp is set to the current time when the script runs
- Keys with the same `key_value` will cause a database error on insert (duplicate primary key)
- Make sure your CSV files use UTF-8 encoding
