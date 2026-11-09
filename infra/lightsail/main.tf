# One Lightsail instance with a static IP. Docker runs the server and Caddy (deploy/compose.yaml);
# deploy/deploy.sh ships images and data. See README "배포 (AWS Lightsail)".

resource "aws_lightsail_key_pair" "deploy" {
  name       = "${var.name}-deploy"
  public_key = file(pathexpand(var.ssh_public_key_path))
}

resource "aws_lightsail_instance" "app" {
  name              = var.name
  availability_zone = var.availability_zone
  blueprint_id      = var.blueprint_id
  bundle_id         = var.bundle_id
  key_pair_name     = aws_lightsail_key_pair.deploy.name
  user_data         = file("${path.module}/user-data.sh")
}

resource "aws_lightsail_static_ip" "app" {
  name = "${var.name}-ip"
}

resource "aws_lightsail_static_ip_attachment" "app" {
  static_ip_name = aws_lightsail_static_ip.app.name
  instance_name  = aws_lightsail_instance.app.name
}

# Replaces the default firewall: SSH (restricted), HTTP for the ACME challenge and redirect, HTTPS (+ HTTP/3).
resource "aws_lightsail_instance_public_ports" "app" {
  instance_name = aws_lightsail_instance.app.name

  port_info {
    protocol  = "tcp"
    from_port = 22
    to_port   = 22
    cidrs     = var.ssh_allowed_cidrs
  }

  port_info {
    protocol  = "tcp"
    from_port = 80
    to_port   = 80
  }

  port_info {
    protocol  = "tcp"
    from_port = 443
    to_port   = 443
  }

  port_info {
    protocol  = "udp"
    from_port = 443
    to_port   = 443
  }
}
