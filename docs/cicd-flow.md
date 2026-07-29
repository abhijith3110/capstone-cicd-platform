# CI/CD Pipeline Flow (AWS Edition)

```mermaid
flowchart TD
    A[Developer opens Pull Request] --> B{Branch protection<br/>+ PR review}
    B -->|Approved & merged to main| C[GitHub Webhook fires]
    C --> D[Jenkins Pipeline Triggered]

    D --> E[Stage 1: Checkout SCM]
    E --> F[Stage 2: Install deps & run unit tests]
    F --> G[Stage 3: SonarQube static analysis]
    G --> H{Quality Gate}
    H -- Fail --> H1[Pipeline aborted<br/>Notify developer]
    H -- Pass --> I[Stage 4: Docker multi-stage build<br/>frontend + backend, parallel]
    I --> J[Stage 5: Trivy vulnerability scan]
    J --> K{Critical/High CVEs?}
    K -- Yes --> K1[Pipeline aborted<br/>Notify developer]
    K -- No --> L[Stage 6: Tag image<br/>v1.BUILD_NUMBER-GIT_SHA]
    L --> M[Stage 7: aws ecr get-login-password<br/>via EC2 IAM role, docker push to ECR]
    M --> N[Stage 8: Refresh ecr-secret<br/>in target namespace<br/>self-healing token refresh]
    N --> O[Stage 9: kubectl apply manifests<br/>ConfigMap/Secret/Deploy/Svc/Ingress/HPA]
    O --> P[Stage 10: kubectl set image<br/>Rolling Update triggered]
    P --> Q{Rollout status OK<br/>within timeout?}
    Q -- No --> R[kubectl rollout undo<br/>Automatic rollback]
    R --> S[Notify team: FAILED + rolled back]
    Q -- Yes --> T[Stage 11: Smoke test<br/>curl /health/ready]
    T --> U{Smoke test passes?}
    U -- No --> R
    U -- Yes --> V[Notify team: SUCCESS]
    V --> W[Deployment live on Kubespray cluster<br/>Zero downtime]
```

## Trigger & Notification Summary

| Event | Mechanism |
|---|---|
| Code pushed / PR merged | GitHub webhook -> Jenkins `githubPush` trigger |
| Build status | `emailext` (or Slack) notification on success/failure |
| Quality gate result | SonarQube webhook -> Jenkins `waitForQualityGate` |
| ECR auth | Jenkins EC2 IAM role -> `aws ecr get-login-password` (no static keys) |
| Pod image pull | `ecr-secret` (docker-registry Secret), refreshed every deploy |
| Deployment failure | Automatic `kubectl rollout undo` + failure notification |
