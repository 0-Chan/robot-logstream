output "public_ip" {
  value = aws_lightsail_static_ip.app.ip_address
}

output "site_address" {
  description = "Host name with a working certificate even without a domain (sslip.io resolves it to the IP)."
  value       = "${replace(aws_lightsail_static_ip.app.ip_address, ".", "-")}.sslip.io"
}

output "ssh" {
  value = "ssh ubuntu@${aws_lightsail_static_ip.app.ip_address}"
}

output "deploy" {
  value = "deploy/deploy.sh ${aws_lightsail_static_ip.app.ip_address}"
}
