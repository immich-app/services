resource "github_organization_webhook" "github_approval_check_webhook" {
  events = [
    "check_run",
    "check_suite",
    "pull_request",
    "pull_request_review",
  ]
  configuration {
    url          = data.terraform_remote_state.github_approval_check.outputs.webhook_url
    content_type = "json"
    secret = var.github_checks_webhook_secret
  }
}
