module "grafana" {
  source = "git::https://github.com/immich-app/devtools.git//tf/shared/modules/grafana?ref=main"

  folder_name     = var.stage != "" ? "cloudflare-metrics (${var.stage})" : "cloudflare-metrics"
  dashboards_path = "./dashboards"
  env             = var.env
}
