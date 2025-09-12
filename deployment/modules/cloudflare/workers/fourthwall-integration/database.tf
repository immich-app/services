# Initialize the D1 database with schema
resource "null_resource" "db_init" {
  depends_on = [cloudflare_d1_database.db]

  triggers = {
    database_id = cloudflare_d1_database.db.id
  }

  provisioner "local-exec" {
    command = <<-EOT
      # Wait for database to be ready
      sleep 10
      
      # Execute SQL schema
      wrangler d1 execute ${cloudflare_d1_database.db.name} --file=${path.root}/../../../../apps/fourthwall-integration/schema.sql --env=production
    EOT
  }
}

# Output the database ID for use in wrangler.toml
output "database_id" {
  value       = cloudflare_d1_database.db.id
  description = "The ID of the D1 database for fourthwall-integration"
}

output "database_name" {
  value       = cloudflare_d1_database.db.name
  description = "The name of the D1 database for fourthwall-integration"
}

output "webhook_queue_id" {
  value       = cloudflare_queue.webhook_processor.id
  description = "The ID of the webhook processor queue"
}

output "fulfillment_queue_id" {
  value       = cloudflare_queue.fulfillment_processor.id
  description = "The ID of the fulfillment processor queue"
}