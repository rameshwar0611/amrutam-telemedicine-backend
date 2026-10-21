data "aws_caller_identity" "current" {
}
resource "aws_kms_key" "data" {
  description = "Amrutam storage/backups/log encryption"
  policy = jsonencode({
    Version = "2012-10-17", Statement = [{
      Sid = "AccountAdministration", Effect = "Allow", Principal = {
        AWS     = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"
      }, Action = "kms:*", Resource = "*"
      }, {
      Sid = "ScopedCloudWatchLogs", Effect = "Allow", Principal = {
        Service = "logs.${var.region}.amazonaws.com"
        }, Action = ["kms:Encrypt", "kms:Decrypt", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:DescribeKey"], Resource = "*", Condition = {
        ArnLike = {
          "kms:EncryptionContext:aws:logs:arn" = "arn:aws:logs:${var.region}:${data.aws_caller_identity.current.account_id}:log-group:/${var.name}/*"
        }
      }
      }, {
      Sid = "FlowLogDelivery", Effect = "Allow", Principal = {
        Service = "delivery.logs.amazonaws.com"
        }, Action = ["kms:GenerateDataKey*", "kms:Decrypt"], Resource = "*", Condition = {
        StringEquals = {
          "aws:SourceAccount" = data.aws_caller_identity.current.account_id
        }
      }
    }]
  })
  enable_key_rotation     = true
  deletion_window_in_days = 30
}
resource "aws_kms_alias" "data" {
  name          = "alias/${var.name}"
  target_key_id = aws_kms_key.data.key_id
}
resource "aws_vpc" "main" {
  cidr_block           = "10.42.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true
}
resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
}
resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index)
  availability_zone       = var.azs[count.index]
  map_public_ip_on_launch = false
}
resource "aws_subnet" "private" {
  count                   = 2
  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index + 10)
  availability_zone       = var.azs[count.index]
  map_public_ip_on_launch = false
}
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
}
resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}
resource "aws_route_table" "private" {
  count  = 2
  vpc_id = aws_vpc.main.id
}
resource "aws_route_table_association" "private" {
  count          = 2
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}
resource "aws_security_group" "alb" {
  name_prefix = "${var.name}-alb-"
  vpc_id      = aws_vpc.main.id
}
resource "aws_security_group" "app" {
  name_prefix = "${var.name}-app-"
  vpc_id      = aws_vpc.main.id
}
resource "aws_security_group" "db" {
  name_prefix = "${var.name}-db-"
  vpc_id      = aws_vpc.main.id
}
resource "aws_security_group" "cache" {
  name_prefix = "${var.name}-cache-"
  vpc_id      = aws_vpc.main.id
}
resource "aws_vpc_security_group_ingress_rule" "https" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}
resource "aws_vpc_security_group_ingress_rule" "redirect" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}
resource "aws_vpc_security_group_egress_rule" "alb_app" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.app.id
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
}
resource "aws_vpc_security_group_ingress_rule" "api" {
  security_group_id            = aws_security_group.app.id
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
}
resource "aws_vpc_security_group_egress_rule" "app_https" {
  security_group_id            = aws_security_group.app.id
  referenced_security_group_id = aws_security_group.endpoints.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
}
resource "aws_vpc_security_group_egress_rule" "app_db" {
  security_group_id            = aws_security_group.app.id
  referenced_security_group_id = aws_security_group.db.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}
resource "aws_vpc_security_group_ingress_rule" "postgres" {
  security_group_id            = aws_security_group.db.id
  referenced_security_group_id = aws_security_group.app.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}
resource "aws_vpc_security_group_egress_rule" "app_cache" {
  security_group_id            = aws_security_group.app.id
  referenced_security_group_id = aws_security_group.cache.id
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
}
resource "aws_vpc_security_group_ingress_rule" "redis" {
  security_group_id            = aws_security_group.cache.id
  referenced_security_group_id = aws_security_group.app.id
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
}
resource "aws_db_subnet_group" "main" {
  name       = var.name
  subnet_ids = aws_subnet.private[*].id
}
resource "aws_db_parameter_group" "main" {
  name_prefix = "${var.name}-"
  family      = "postgres17"
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  parameter {
    name  = "log_statement"
    value = "none"
  }
  parameter {
    name  = "log_min_duration_statement"
    value = "-1"
  }
  parameter {
    name  = "log_min_error_statement"
    value = "panic"
  }
  parameter {
    name  = "log_parameter_max_length_on_error"
    value = "0"
  }
}
resource "aws_iam_role" "rds_monitor" {
  name = "${var.name}-rds-monitor"
  assume_role_policy = jsonencode({
    Version = "2012-10-17", Statement = [{
      Effect = "Allow", Principal = {
        Service = "monitoring.rds.amazonaws.com"
      }, Action = "sts:AssumeRole"
    }]
  })
}
resource "aws_iam_role_policy_attachment" "rds_monitor" {
  role       = aws_iam_role.rds_monitor.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}
resource "aws_db_instance" "main" {
  identifier                      = var.name
  engine                          = "postgres"
  engine_version                  = "17"
  instance_class                  = "db.t4g.medium"
  allocated_storage               = 100
  max_allocated_storage           = 1000
  storage_type                    = "gp3"
  storage_encrypted               = true
  kms_key_id                      = aws_kms_key.data.arn
  db_name                         = "amrutam"
  username                        = "amrutam_owner"
  manage_master_user_password     = true
  master_user_secret_kms_key_id   = aws_kms_key.data.arn
  multi_az                        = true
  publicly_accessible             = false
  db_subnet_group_name            = aws_db_subnet_group.main.name
  vpc_security_group_ids          = [aws_security_group.db.id]
  parameter_group_name            = aws_db_parameter_group.main.name
  backup_retention_period         = 14
  backup_window                   = "20:00-21:00"
  maintenance_window              = "sun:21:00-sun:22:00"
  copy_tags_to_snapshot           = true
  deletion_protection             = true
  skip_final_snapshot             = false
  final_snapshot_identifier       = "${var.name}-final"
  auto_minor_version_upgrade      = true
  monitoring_interval             = 60
  monitoring_role_arn             = aws_iam_role.rds_monitor.arn
  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]
  lifecycle {
    prevent_destroy = true
  }
}
resource "aws_elasticache_subnet_group" "main" {
  name       = var.name
  subnet_ids = aws_subnet.private[*].id
}
resource "aws_elasticache_replication_group" "main" {
  replication_group_id       = var.name
  description                = "Private encrypted Valkey; never booking authority"
  engine                     = "valkey"
  engine_version             = "7.2"
  node_type                  = "cache.t4g.small"
  num_cache_clusters         = 2
  automatic_failover_enabled = true
  multi_az_enabled           = true
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  kms_key_id                 = aws_kms_key.data.arn
  auth_token                 = var.cache_auth_token
  subnet_group_name          = aws_elasticache_subnet_group.main.name
  security_group_ids         = [aws_security_group.cache.id]
  snapshot_retention_limit   = 7
}
resource "aws_ecr_repository" "app" {
  name                 = var.name
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.data.arn
  }
}
resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1, description = "Retain 30 immutable images", selection = {
        tagStatus = "any", countType = "imageCountMoreThan", countNumber = 30
        }, action = {
        type = "expire"
      }
    }]
  })
}
resource "aws_s3_bucket" "logs" {
  bucket_prefix = "${var.name}-alb-"
}
resource "aws_s3_bucket_public_access_block" "logs" {
  bucket                  = aws_s3_bucket.logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_server_side_encryption_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.data.arn
    }
  }
}
resource "aws_s3_bucket_versioning" "logs" {
  bucket = aws_s3_bucket.logs.id
  versioning_configuration {
    status = "Enabled"
  }
}
resource "aws_s3_bucket_policy" "logs" {
  bucket = aws_s3_bucket.logs.id
  policy = jsonencode({
    Version = "2012-10-17", Statement = [{
      Effect    = "Allow", Principal = { Service = "delivery.logs.amazonaws.com" },
      Action    = "s3:GetBucketAcl", Resource = aws_s3_bucket.logs.arn,
      Condition = { StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id } }
      }, {
      Effect = "Allow", Principal = {
        Service = "delivery.logs.amazonaws.com"
        }, Action = "s3:PutObject", Resource = "${aws_s3_bucket.logs.arn}/AWSLogs/${data.aws_caller_identity.current.account_id}/*", Condition = {
        StringEquals = {
          "aws:SourceAccount" = data.aws_caller_identity.current.account_id, "s3:x-amz-acl" = "bucket-owner-full-control"
        }
      }
      }, {
      Effect = "Deny", Principal = "*", Action = "s3:*", Resource = [aws_s3_bucket.logs.arn, "${aws_s3_bucket.logs.arn}/*"], Condition = {
        Bool = {
          "aws:SecureTransport" = "false"
        }
      }
    }]
  })
}
#trivy:ignore:AVD-AWS-0053:exp:2027-01-21 Public HTTPS edge is required; application/database subnets remain private.
resource "aws_lb" "api" {
  name                       = var.name
  internal                   = false
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb.id]
  subnets                    = aws_subnet.public[*].id
  enable_deletion_protection = true
  drop_invalid_header_fields = true
  depends_on                 = [aws_s3_bucket_policy.logs]
}
resource "aws_lb_target_group" "api" {
  name                 = var.name
  port                 = 3000
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = aws_vpc.main.id
  deregistration_delay = 30
  health_check {
    path    = "/health/ready"
    matcher = "200"
  }
}
resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.api.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.api.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}
resource "aws_cloudwatch_log_group" "app" {
  name              = "/${var.name}/application"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.data.arn
}
resource "aws_cloudwatch_log_group" "otel" {
  name              = "/${var.name}/otel"
  retention_in_days = 14
  kms_key_id        = aws_kms_key.data.arn
}
resource "aws_ecs_cluster" "main" {
  name = var.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}
locals {
  roles = {
    api = var.api_secret_arn, worker = var.worker_secret_arn, migrate = var.migration_secret_arn, maintenance = var.maintenance_secret_arn
  }
  commands = {
    api = ["node", "dist/entrypoints/api.js"], worker = ["node", "dist/entrypoints/worker.js"], migrate = ["node", "dist/entrypoints/migrate.js", "up"], maintenance = ["node", "dist/entrypoints/maintenance.js"]
  }
  api_secrets = ["DATABASE_URL", "DATABASE_CA_CERT", "REDIS_URL", "AUTH_JWT_KEY_ID", "AUTH_JWT_PRIVATE_KEY_BASE64", "AUTH_JWT_PUBLIC_KEYS", "AUTH_ENCRYPTION_KEY_ID", "AUTH_ENCRYPTION_KEYS", "AUTH_TOKEN_PEPPER_BASE64", "AUTH_JWT_ISSUER", "AUTH_JWT_AUDIENCE"]
}
resource "aws_iam_role" "execution" {
  for_each = local.roles
  name     = "${var.name}-${each.key}-execution"
  assume_role_policy = jsonencode({
    Version = "2012-10-17", Statement = [{
      Effect = "Allow", Principal = {
        Service = "ecs-tasks.amazonaws.com"
      }, Action = "sts:AssumeRole"
    }]
  })
}
resource "aws_iam_role_policy_attachment" "execution" {
  for_each   = local.roles
  role       = aws_iam_role.execution[each.key].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}
resource "aws_iam_role_policy" "secrets" {
  for_each = local.roles
  role     = aws_iam_role.execution[each.key].id
  policy = jsonencode({
    Version = "2012-10-17", Statement = [{
      Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = each.value
      }, {
      Effect = "Allow", Action = ["kms:Decrypt"], Resource = var.secrets_kms_key_arn
    }]
  })
}
resource "aws_iam_role" "task" {
  for_each = local.roles
  name     = "${var.name}-${each.key}-task"
  assume_role_policy = jsonencode({
    Version = "2012-10-17", Statement = [{
      Effect = "Allow", Principal = {
        Service = "ecs-tasks.amazonaws.com"
      }, Action = "sts:AssumeRole"
    }]
  })
}
resource "aws_iam_role_policy" "telemetry" {
  for_each = local.roles
  role     = aws_iam_role.task[each.key].id
  policy = jsonencode({
    Version = "2012-10-17", Statement = [{
      Effect = "Allow", Action = ["xray:PutTraceSegments", "xray:PutTelemetryRecords"], Resource = "*"
      }, {
      Effect = "Allow", Action = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:DescribeLogStreams", "logs:PutLogEvents"], Resource = [aws_cloudwatch_log_group.otel.arn, "${aws_cloudwatch_log_group.otel.arn}:*"]
    }]
  })
}
resource "aws_ecs_task_definition" "app" {
  for_each                 = local.roles
  family                   = "${var.name}-${each.key}"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.execution[each.key].arn
  task_role_arn            = aws_iam_role.task[each.key].arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  container_definitions = jsonencode([{
    name = each.key, image = "${aws_ecr_repository.app.repository_url}@${var.image_digest}", essential = true, readonlyRootFilesystem = true, user = "1000:1000", command = local.commands[each.key], stopTimeout = 60,
    healthCheck = contains(["api", "worker"], each.key) ? {
      command     = ["CMD", "node", "-e", "fetch('http://127.0.0.1:${each.key == "api" ? 3000 : 3001}/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval    = 15
      timeout     = 5
      retries     = 3
      startPeriod = 30
    } : null,
    portMappings = contains(["api", "worker"], each.key) ? [{
      containerPort = each.key == "api" ? 3000 : 3001, protocol = "tcp"
    }] : [],
    environment = concat([{
      name = "NODE_ENV", value = "production"
      }, {
      name = "DATABASE_SSL_MODE", value = "verify-full"
      }, {
      name = "OTEL_ENABLED", value = "true"
      }, {
      name = "OTEL_SAMPLE_RATIO", value = "0.1"
      }, {
      name = "OTEL_EXPORTER_OTLP_ENDPOINT", value = "http://localhost:4318"
      }], each.key == "api" ? [{
      name = "TRUST_PROXY_CIDRS", value = "10.42.0.0/24,10.42.1.0/24"
    }] : []),
    secrets = [for key in each.key == "api" ? local.api_secrets : each.key == "worker" ? ["DATABASE_URL", "DATABASE_CA_CERT", "REDIS_URL"] : ["DATABASE_URL", "DATABASE_CA_CERT"] : {
      name = key, valueFrom = "${each.value}:${key}::"
    }],
    logConfiguration = {
      logDriver = "awslogs", options = {
        "awslogs-group" = aws_cloudwatch_log_group.app.name, "awslogs-region" = var.region, "awslogs-stream-prefix" = each.key
      }
    }
    }, {
    name = "collector", image = "${aws_ecr_repository.collector.repository_url}@${var.collector_image_digest}", essential = false,
    command = ["--config=env:OTEL_CONFIG"], environment = [
      { name = "AWS_REGION", value = var.region },
      { name = "OTEL_LOG_GROUP", value = aws_cloudwatch_log_group.otel.name },
      { name = "OTEL_CONFIG", value = file("${path.module}/../observability/aws-collector.yaml") }
    ],
    logConfiguration = {
      logDriver = "awslogs", options = {
        "awslogs-group" = aws_cloudwatch_log_group.app.name, "awslogs-region" = var.region, "awslogs-stream-prefix" = "collector-${each.key}"
      }
    }
  }])
}
resource "aws_ecs_service" "api" {
  name            = "api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.app["api"].arn
  desired_count   = 2
  launch_type     = "FARGATE"
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = false
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 3000
  }
  health_check_grace_period_seconds = 60
  depends_on                        = [aws_lb_listener.https]
  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }
}
resource "aws_ecs_service" "worker" {
  name            = "worker"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.app["worker"].arn
  desired_count   = 2
  launch_type     = "FARGATE"
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = false
  }
  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }
}
resource "aws_appautoscaling_target" "api" {
  max_capacity       = 10
  min_capacity       = 2
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.api.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}
resource "aws_appautoscaling_policy" "api" {
  name               = "${var.name}-cpu"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension
  service_namespace  = "ecs"
  target_tracking_scaling_policy_configuration {
    target_value = 60
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}
resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}
resource "aws_iam_role" "github" {
  name = "${var.name}-github"
  assume_role_policy = jsonencode({
    Version = "2012-10-17", Statement = [{
      Effect = "Allow", Principal = {
        Federated = aws_iam_openid_connect_provider.github.arn
        }, Action = "sts:AssumeRoleWithWebIdentity", Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com", "token.actions.githubusercontent.com:sub" = "repo:${var.github_repository}:environment:staging"
        }
      }
    }]
  })
}
resource "aws_iam_role_policy" "github" {
  role = aws_iam_role.github.id
  policy = jsonencode({
    Version = "2012-10-17", Statement = [
      {
        Effect = "Allow", Action = ["ecr:GetAuthorizationToken", "ecs:RegisterTaskDefinition", "ecs:DescribeTaskDefinition", "ecs:DescribeTasks"], Resource = "*"
      },
      {
        Effect = "Allow", Action = ["ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage", "ecr:BatchGetImage"], Resource = aws_ecr_repository.app.arn
      },
      {
        Effect = "Allow", Action = ["ecs:UpdateService", "ecs:DescribeServices"], Resource = [aws_ecs_service.api.id, aws_ecs_service.worker.id]
      },
      {
        Effect = "Allow", Action = ["ecs:RunTask"], Resource = "arn:aws:ecs:${var.region}:${data.aws_caller_identity.current.account_id}:task-definition/${var.name}-migrate:*"
      },
      {
        Effect = "Allow", Action = ["iam:PassRole"], Resource = concat([for role in aws_iam_role.execution : role.arn], [for role in aws_iam_role.task : role.arn]), Condition = {
          StringEquals = {
            "iam:PassedToService" = "ecs-tasks.amazonaws.com"
          }
        }
      }
    ]
  })
}
resource "aws_iam_role" "scheduler" {
  name = "${var.name}-maintenance-scheduler"
  assume_role_policy = jsonencode({
    Version = "2012-10-17", Statement = [{
      Effect = "Allow", Principal = {
        Service = "scheduler.amazonaws.com"
      }, Action = "sts:AssumeRole"
    }]
  })
}
resource "aws_iam_role_policy" "scheduler" {
  role = aws_iam_role.scheduler.id
  policy = jsonencode({
    Version = "2012-10-17", Statement = [{
      Effect = "Allow", Action = "ecs:RunTask", Resource = aws_ecs_task_definition.app["maintenance"].arn
      }, {
      Effect = "Allow", Action = "iam:PassRole", Resource = [aws_iam_role.execution["maintenance"].arn, aws_iam_role.task["maintenance"].arn]
    }]
  })
}
resource "aws_scheduler_schedule" "maintenance" {
  name                = "${var.name}-maintenance"
  schedule_expression = "rate(1 hour)"
  flexible_time_window {
    mode = "OFF"
  }
  target {
    arn      = aws_ecs_cluster.main.arn
    role_arn = aws_iam_role.scheduler.arn
    ecs_parameters {
      task_definition_arn = aws_ecs_task_definition.app["maintenance"].arn
      launch_type         = "FARGATE"
      network_configuration {
        subnets          = aws_subnet.private[*].id
        security_groups  = [aws_security_group.app.id]
        assign_public_ip = false
      }
    }
    retry_policy {
      maximum_event_age_in_seconds = 3600
      maximum_retry_attempts       = 2
    }
  }
}
resource "aws_cloudwatch_metric_alarm" "db_cpu" {
  alarm_name          = "${var.name}-db-cpu"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "CPUUtilization"
  namespace           = "AWS/RDS"
  period              = 60
  statistic           = "Average"
  threshold           = 80
  dimensions = {
    DBInstanceIdentifier = aws_db_instance.main.id
  }
  alarm_actions = [var.alarm_topic_arn]
}
resource "aws_cloudwatch_metric_alarm" "alb_errors" {
  alarm_name          = "${var.name}-api-5xx"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "HTTPCode_Target_5XX_Count"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Sum"
  threshold           = 5
  dimensions = {
    LoadBalancer = aws_lb.api.arn_suffix
  }
  alarm_actions = [var.alarm_topic_arn]
}
resource "aws_cloudwatch_metric_alarm" "alb_latency" {
  alarm_name          = "${var.name}-api-latency"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "TargetResponseTime"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  extended_statistic  = "p95"
  threshold           = 0.5
  dimensions = {
    LoadBalancer = aws_lb.api.arn_suffix
  }
  alarm_actions = [var.alarm_topic_arn]
}
resource "aws_flow_log" "vpc" {
  vpc_id               = aws_vpc.main.id
  traffic_type         = "ALL"
  log_destination_type = "s3"
  log_destination      = aws_s3_bucket.logs.arn
}
resource "aws_security_group" "endpoints" {
  name_prefix = "${var.name}-endpoints-"
  vpc_id      = aws_vpc.main.id
}
resource "aws_vpc_security_group_ingress_rule" "endpoints" {
  security_group_id            = aws_security_group.endpoints.id
  referenced_security_group_id = aws_security_group.app.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
}
resource "aws_vpc_endpoint" "interfaces" {
  for_each            = toset(["ecr.api", "ecr.dkr", "logs", "secretsmanager", "xray", "monitoring"])
  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.${var.region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  private_dns_enabled = true
  subnet_ids          = aws_subnet.private[*].id
  security_group_ids  = [aws_security_group.endpoints.id]
}
resource "aws_vpc_endpoint" "s3" {
  vpc_id          = aws_vpc.main.id
  service_name    = "com.amazonaws.${var.region}.s3"
  route_table_ids = aws_route_table.private[*].id
}
resource "aws_vpc_security_group_egress_rule" "ecr_layers" {
  security_group_id = aws_security_group.app.id
  prefix_list_id    = aws_vpc_endpoint.s3.prefix_list_id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}
resource "aws_ecr_repository" "collector" {
  name                 = "${var.name}-collector"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.data.arn
  }
}

# Metric names/dimensions must be smoke-tested against the reviewed ADOT image
# before cloud rollout. These definitions are not evidence of delivered alarms.
locals {
  operational_alarms = {
    worker_backlog    = { metric = "worker_oldest_pending_seconds", threshold = 60, statistic = "Maximum", dimensions = { "service.name" = "amrutam-worker" } }
    terminal_jobs     = { metric = "worker_backlog", threshold = 0, statistic = "Maximum", dimensions = { "service.name" = "amrutam-worker", state = "failed" } }
    database_waiters  = { metric = "db_pool_connections", threshold = 0, statistic = "Maximum", dimensions = { "service.name" = "amrutam-api", state = "waiting" } }
    auth_abuse        = { metric = "auth_failures_total", threshold = 300, statistic = "Sum", dimensions = { "service.name" = "amrutam-api" } }
    booking_conflicts = { metric = "booking_conflicts_total", threshold = 300, statistic = "Sum", dimensions = { "service.name" = "amrutam-api" } }
  }
}
resource "aws_cloudwatch_metric_alarm" "operations" {
  for_each            = local.operational_alarms
  alarm_name          = "${var.name}-${each.key}"
  namespace           = "Amrutam"
  metric_name         = each.value.metric
  dimensions          = each.value.dimensions
  statistic           = each.value.statistic
  threshold           = each.value.threshold
  comparison_operator = "GreaterThanThreshold"
  period              = 60
  evaluation_periods  = 2
  treat_missing_data  = "missing"
  alarm_actions       = [var.alarm_topic_arn]
}
resource "aws_cloudwatch_metric_alarm" "api_unhealthy" {
  alarm_name          = "${var.name}-api-no-healthy-targets"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HealthyHostCount"
  dimensions          = { LoadBalancer = aws_lb.api.arn_suffix, TargetGroup = aws_lb_target_group.api.arn_suffix }
  statistic           = "Minimum"
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  period              = 60
  evaluation_periods  = 2
  treat_missing_data  = "breaching"
  alarm_actions       = [var.alarm_topic_arn]
}
