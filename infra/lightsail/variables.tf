variable "region" {
  description = "Lightsail region. ap-northeast-2 = Seoul."
  type        = string
  default     = "ap-northeast-2"
}

variable "availability_zone" {
  type    = string
  default = "ap-northeast-2a"
}

variable "name" {
  description = "Prefix for every Lightsail resource."
  type        = string
  default     = "robot-logstream"
}

variable "bundle_id" {
  description = <<-EOT
    Instance plan. small_3_0 = 2 GB RAM, 60 GB SSD, 3 TB transfer (USD 12/month at the time of writing).
    The server holds ~150 MB of series in memory and needs ~11 GB of disk for one sequence.
    List plans: aws lightsail get-bundles --region ap-northeast-2
  EOT
  type        = string
  default     = "small_3_0"
}

variable "blueprint_id" {
  description = "OS image. List: aws lightsail get-blueprints --region ap-northeast-2"
  type        = string
  default     = "ubuntu_24_04"
}

variable "ssh_public_key_path" {
  description = "Public key installed for the ubuntu user (deploy.sh uses ssh/rsync)."
  type        = string
  default     = "~/.ssh/id_ed25519.pub"
}

variable "ssh_allowed_cidrs" {
  description = "Who may reach port 22. Narrow this to your own IP, e.g. [\"203.0.113.7/32\"]."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "tags" {
  type    = map(string)
  default = { project = "robot-logstream" }
}
