#!/usr/bin/env bash
set -euo pipefail
[[ ${CONFIRM_STAGING_DEPLOY:-} == yes ]] || { echo 'Explicit deployment confirmation required' >&2; exit 1; }
: "${ECS_CLUSTER:?}" "${ECR_REPOSITORY:?}" "${IMAGE_DIGEST:?}" "${PRIVATE_SUBNETS:?}" "${SECURITY_GROUP:?}" "${STAGING_URL:?}"
[[ $IMAGE_DIGEST =~ ^sha256:[a-f0-9]{64}$ ]] || exit 1
mkdir -p work/deploy
for service in api worker; do aws ecs describe-services --cluster "$ECS_CLUSTER" --services "$service" --query 'services[0].taskDefinition' --output text > "work/deploy/old-$service.txt"; done
rollback() { for service in api worker; do aws ecs update-service --cluster "$ECS_CLUSTER" --service "$service" --task-definition "$(cat "work/deploy/old-$service.txt")" --query 'service.serviceName' --output text; done; }
trap rollback ERR
for service in migrate api worker; do
 aws ecs describe-task-definition --task-definition "${ECS_CLUSTER}-${service}" --query taskDefinition > "work/deploy/$service.json"
 jq --arg image "$ECR_REPOSITORY@$IMAGE_DIGEST" --arg name "$service" 'del(.taskDefinitionArn,.revision,.status,.requiresAttributes,.compatibilities,.registeredAt,.registeredBy) | (.containerDefinitions[] | select(.name==$name) | .image)=$image' "work/deploy/$service.json" > "work/deploy/$service-new.json"
 aws ecs register-task-definition --cli-input-json "file://work/deploy/$service-new.json" --query 'taskDefinition.taskDefinitionArn' --output text > "work/deploy/$service-arn.txt"
done
TASK_ARN=$(aws ecs run-task --cluster "$ECS_CLUSTER" --launch-type FARGATE --task-definition "$(cat work/deploy/migrate-arn.txt)" --network-configuration "awsvpcConfiguration={subnets=[$PRIVATE_SUBNETS],securityGroups=[$SECURITY_GROUP],assignPublicIp=DISABLED}" --query 'tasks[0].taskArn' --output text)
[[ $TASK_ARN != None && -n $TASK_ARN ]]
aws ecs wait tasks-stopped --cluster "$ECS_CLUSTER" --tasks "$TASK_ARN"
[[ $(aws ecs describe-tasks --cluster "$ECS_CLUSTER" --tasks "$TASK_ARN" --query 'tasks[0].containers[?name==`migrate`].exitCode | [0]' --output text) == 0 ]]
for service in api worker; do aws ecs update-service --cluster "$ECS_CLUSTER" --service "$service" --task-definition "$(cat "work/deploy/$service-arn.txt")" --query 'service.serviceName' --output text; done
aws ecs wait services-stable --cluster "$ECS_CLUSTER" --services api worker
node scripts/staging-smoke.mjs
trap - ERR
