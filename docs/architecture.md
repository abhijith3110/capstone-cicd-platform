# Deployment Architecture (AWS Edition)

```mermaid
graph TB
    subgraph Dev["Developer Workstation"]
        DEV[Developer] -->|git push| GH
    end
    subgraph SCM["Source Control"]
        GH[(GitHub Repository)]
    end

    subgraph AWS["AWS Account"]
        subgraph CI["EC2: CI/CD Layer"]
            JK[Jenkins EC2<br/>IAM Role: ECR push/pull]
            SQ[SonarQube EC2]
        end

        subgraph ECR["Amazon ECR"]
            ECRB[(capstone1-backend)]
            ECRF[(capstone1-frontend)]
        end

        subgraph K8S["Kubespray Kubernetes Cluster (3+ EC2 nodes)"]
            ING[ingress-nginx Controller<br/>NodePort]
            subgraph NS["Namespace: capstone1"]
                FE[Frontend Deployment<br/>Pods]
                BE[Backend Deployment<br/>Pods]
                DB[(MySQL StatefulSet + PVC)]
                CM[ConfigMap]
                SEC[Secret]
                ECRSEC[ecr-secret<br/>refreshed every deploy]
                HPA1[HPA: Frontend]
                HPA2[HPA: Backend]
            end
        end
    end

    GH -->|Webhook triggers build| JK
    JK -->|npm test| JK
    JK -->|Static + security scan| SQ
    SQ -->|Quality Gate pass/fail| JK
    JK -->|docker build multi-stage| JK
    JK -->|trivy scan| JK
    JK -->|aws ecr get-login-password<br/>via IAM role, no static creds| ECRB
    JK -->|docker push| ECRB
    JK -->|docker push| ECRF
    JK -->|kubectl create secret<br/>docker-registry ecr-secret| ECRSEC
    JK -->|kubectl apply / set image| ING
    ECRB -.image pull using ecr-secret.-> BE
    ECRF -.image pull using ecr-secret.-> FE
    ING --> FE
    ING -->|/api| BE
    BE --> DB
    CM -.env vars.-> BE
    SEC -.credentials.-> BE
    CM -.env vars.-> FE
    HPA1 -.scales.-> FE
    HPA2 -.scales.-> BE
```

## Component Notes

- **IAM Role (EC2 instance profile)**: attached to the Jenkins EC2 instance, grants `ecr:GetAuthorizationToken`,
  `ecr:BatchCheckLayerAvailability`, `ecr:PutImage`, `ecr:InitiateLayerUpload`, etc. No AWS access keys are
  stored anywhere in Jenkins.
- **ecr-secret**: a Kubernetes `docker-registry` Secret containing a short-lived ECR token. kubelet does **not**
  automatically inherit the EC2 instance's IAM role, so pods need this Secret referenced via `imagePullSecrets`
  to pull from ECR. ECR tokens expire in ~12 hours, so the pipeline refreshes this Secret on every deploy —
  making the pipeline self-healing against expired tokens.
- **Ingress**: single entry point (NodePort-backed), routes `/` to the frontend Service and `/api` to the backend.
- **Database tier**: MySQL StatefulSet with a PersistentVolumeClaim. Kubespray ships no default StorageClass,
  so a provisioner (e.g. `local-path-provisioner`) must be installed first — see README §7.
- **Zero downtime**: `maxUnavailable: 0`, `maxSurge: 1` rolling update strategy + readiness probes.
