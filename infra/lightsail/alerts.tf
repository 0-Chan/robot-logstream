# Second line of defence: an AWS cost budget that e-mails when the month's bill heads past the plan.
# The server's own transfer alerts (deploy/.env) are faster and more precise; billing data here lags
# by hours to a day. Created only when alert_emails is set. The first two budgets per account are free.

variable "alert_emails" {
  description = "Addresses that get AWS Budgets e-mails (no confirmation step). Empty = no budget."
  type        = list(string)
  default     = []
}

variable "budget_limit_usd" {
  description = "Monthly cost budget. The instance alone is USD 12, so the default leaves a little room."
  type        = number
  default     = 15
}

variable "alert_sns_topic_arn" {
  description = "Optional SNS topic that also receives the alerts (attach SMS or other subscriptions to it)."
  type        = string
  default     = ""
}

locals {
  budget_notifications = [
    { type = "ACTUAL", threshold = 80 },
    { type = "ACTUAL", threshold = 100 },
    { type = "FORECASTED", threshold = 100 },
  ]
}

resource "aws_budgets_budget" "monthly" {
  count        = length(var.alert_emails) > 0 ? 1 : 0
  name         = "${var.name}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.budget_limit_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_filter {
    name   = "Service"
    values = ["Amazon Lightsail"]
  }

  dynamic "notification" {
    for_each = local.budget_notifications
    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value.threshold
      threshold_type             = "PERCENTAGE"
      notification_type          = notification.value.type
      subscriber_email_addresses = var.alert_emails
      subscriber_sns_topic_arns  = var.alert_sns_topic_arn == "" ? [] : [var.alert_sns_topic_arn]
    }
  }
}
