terraform {
  backend "pg" {}
  required_version = "~> 1.7"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = ">= 5, < 5.20.0"
    }
    grafana = {
      source  = "grafana/grafana"
      version = "~> 3"
    }
  }
}
