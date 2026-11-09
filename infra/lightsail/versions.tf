terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # State stays local (terraform.tfstate, gitignored). To share it, add an S3 backend here.
}

provider "aws" {
  region = var.region

  default_tags {
    tags = var.tags
  }
}
