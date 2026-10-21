output "cluster" {
  value = aws_ecs_cluster.main.name
}
output "repository_url" {
  value = aws_ecr_repository.app.repository_url
}
output "load_balancer_dns_name" {
  description = "Create a reviewed DNS alias matching the supplied certificate; the ALB DNS name is not a verified HTTPS origin."
  value       = aws_lb.api.dns_name
}
output "database_endpoint" {
  value = aws_db_instance.main.address
}
output "cache_endpoint" {
  value = aws_elasticache_replication_group.main.primary_endpoint_address
}
output "github_role_arn" {
  value = aws_iam_role.github.arn
}
output "private_subnets" {
  value = aws_subnet.private[*].id
}
output "application_security_group" {
  value = aws_security_group.app.id
}
