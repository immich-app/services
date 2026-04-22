module "grafana" {
  source = "git::https://github.com/immich-app/devtools.git//tf/shared/modules/grafana?ref=main"

  folder_name     = local.grafana_folder_name
  dashboards_path = "./dashboards"
  env             = var.env
}
