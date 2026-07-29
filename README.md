# Capstone Project 1 — Enterprise CI/CD Platform for a Three-Tier Web Application 

Automates the full software delivery lifecycle: GitHub → Jenkins (EC2) → SonarQube (EC2) → Docker →
Amazon ECR → self-managed Kubernetes on EC2 (Kubespray), with zero-downtime rolling updates and
automatic rollback.

**Stack:** Frontend (Nginx-served static app) → Backend (Node.js/Express API) → MySQL, all containerized
and deployed to Kubernetes.

See also: [`docs/architecture.md`](docs/architecture.md) and [`docs/cicd-flow.md`](docs/cicd-flow.md) for diagrams.

---

## 0. Repo Layout

```
capstone-cicd-platform/
├── app/
│   ├── backend/          # Node.js/Express API (Tier 2)
│   │   ├── src/
│   │   ├── Dockerfile
│   │   └── package.json
│   └── frontend/         # Static app + Nginx (Tier 1)
│       ├── src/
│       ├── Dockerfile
│       └── nginx.conf
├── db/init.sql           # local dev DB seed (Tier 3)
├── k8s/                  # all Kubernetes manifests
├── docs/                 # architecture + CI/CD diagrams
├── Jenkinsfile
├── sonar-project.properties
├── docker-compose.yml    # local dev only
└── README.md
```

---

## 1. Source Code Management (GitHub)

### 1.1 Create the repository
```bash
git init
git remote add origin https://github.com/<your-username>/capstone-cicd-platform.git
git add .
git commit -m "chore: initial project scaffold"
git branch -M main
git push -u origin main
```

### 1.2 Branching strategy
- `main` — always deployable, protected, maps to **prod**
- `develop` — integration branch, maps to **staging**
- `feature/<ticket-id>-short-desc` — new work, branched from `develop`
- `hotfix/<ticket-id>` — urgent prod fixes, branched from `main`

```bash
git checkout -b develop
git push -u origin develop
git checkout -b feature/JIRA-101-items-endpoint develop
```

### 1.3 Branch protection (GitHub UI: Settings → Branches → Add rule)
- Require pull request before merging (min 1 approval)
- Require status checks to pass: `Jenkins CI`, `SonarQube Quality Gate`
- Block force pushes to `main` and `develop`

### 1.4 Pull Request workflow
1. Push `feature/*` branch → open PR into `develop`.
2. Jenkins auto-triggers a build via webhook (tests + SonarQube run on the PR).
3. Reviewer approves once checks are green.
4. Merge → triggers the pipeline → builds, pushes to ECR, deploys.
5. Periodically PR `develop` → `main` for a prod release.

---

## 2. AWS Infrastructure Setup

You need **5 EC2 instances** (matches a realistic small setup):
1. Jenkins server (t3.medium or larger — builds need CPU/RAM)
2. SonarQube server (t3.medium — SonarQube is memory-hungry)
3–5. Kubernetes nodes (t3.medium+, at least 1 control-plane + 2 workers) for Kubespray

### 2.1 Launch the EC2 instances
- AMI: Ubuntu 24.04 LTS
- All instances in the same VPC/subnet so they can reach each other privately
- Attach a Security Group allowing:
  - SSH (22) from your IP
  - Jenkins UI (8080) from your IP
  - SonarQube UI (9000) from your IP
  - Kubernetes API (6443) between cluster nodes + from Jenkins
  - NodePort range (30000-32767) open for ingress-nginx, at least from your IP
  - All traffic between the 3 K8s nodes on their private IPs (etcd, kubelet, flannel/calico overlay)

### 2.2 Create the IAM role for ECR access
This is the key piece that replaces static Docker Hub credentials:

1. IAM → Roles → Create role → Trusted entity: **EC2**
2. Attach policy `AmazonEC2ContainerRegistryFullAccess` (or a scoped-down custom policy with
   `ecr:GetAuthorizationToken`, `ecr:BatchCheckLayerAvailability`, `ecr:PutImage`,
   `ecr:InitiateLayerUpload`, `ecr:UploadLayerPart`, `ecr:CompleteLayerUpload`,
   `ecr:CreateRepository`, `ecr:DescribeRepositories`)
3. Name it e.g. `jenkins-ecr-role`
4. Attach it to the **Jenkins EC2 instance** (EC2 console → instance → Actions → Security →
   Modify IAM role)

With this role attached, the Jenkins agent can run `aws ecr get-login-password` with **zero stored
AWS credentials**.

### 2.3 Create the ECR repositories
```bash
aws ecr create-repository --repository-name capstone1-backend --region <your-region>
aws ecr create-repository --repository-name capstone1-frontend --region <your-region>
```
(The Jenkinsfile also auto-creates these if they don't exist, but doing it once manually confirms your
IAM role/CLI setup works.)

---

## 3. Kubernetes Cluster (Kubespray, on the 3 EC2 nodes)

### 3.1 Provision the cluster
From the Jenkins EC2 instance (or a separate bastion) with SSH access to all 3 K8s node IPs:
```bash
git clone https://github.com/kubernetes-sigs/kubespray.git
cd kubespray
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt

cp -rfp inventory/sample inventory/capstone1
declare -a IPS=(<node1-private-ip> <node2-private-ip> <node3-private-ip>)
CONFIG_FILE=inventory/capstone1/hosts.yaml python3 contrib/inventory_builder/inventory.py ${IPS[@]}

# Edit inventory/capstone1/hosts.yaml: assign kube_control_plane / etcd on node1,
# kube_node on all 3 (or split control-plane/workers if you have more instances)
ansible-playbook -i inventory/capstone1/hosts.yaml --become --become-user=root cluster.yml
```

### 3.2 Fetch kubeconfig
```bash
scp ubuntu@<control-plane-ip>:/etc/kubernetes/admin.conf ~/.kube/config
kubectl get nodes    # should show all 3 nodes Ready
```
Save this file as the `kubeconfig-kubespray` Jenkins **Secret File** credential.

### 3.3 Install ingress-nginx
```bash
kubectl create namespace ingress-nginx
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm install ingress-nginx ingress-nginx/ingress-nginx -n ingress-nginx \
  --set controller.service.type=NodePort
```

### 3.4 Install a StorageClass provisioner
Kubespray ships **no default StorageClass**, so the MySQL PVC will sit `Pending` without one:
```bash
kubectl apply -f https://raw.githubusercontent.com/rancher/local-path-provisioner/master/deploy/local-path-storage.yaml
kubectl patch storageclass local-path -p '{"metadata": {"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'
```

### 3.5 Install metrics-server (required for HPA)
```bash
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
```

---

## 4. Jenkins Setup

### 4.1 Install Jenkins
```bash
sudo apt update
sudo apt install -y openjdk-21-jre   # Jenkins on newer versions needs Java 21, not 17
curl -fsSL https://pkg.jenkins.io/debian-stable/jenkins.io-2023.key | sudo tee \
  /usr/share/keyrings/jenkins-keyring.asc > /dev/null
echo "deb [signed-by=/usr/share/keyrings/jenkins-keyring.asc]" \
  https://pkg.jenkins.io/debian-stable binary/ | sudo tee /etc/apt/sources.list.d/jenkins.list > /dev/null
sudo apt update
sudo apt install -y jenkins
sudo systemctl enable --now jenkins
```
Visit `http://<jenkins-ec2-public-ip>:8080`, unlock with `/var/lib/jenkins/secrets/initialAdminPassword`,
install **Suggested Plugins**.

### 4.2 Required Jenkins plugins
Pipeline, GitHub Integration + GitHub Branch Source, SonarQube Scanner, Docker Pipeline,
Kubernetes CLI, Email Extension.

### 4.3 Tooling on the Jenkins EC2 instance
```bash
# Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker jenkins

# AWS CLI v2 (needed to talk to ECR using the instance's IAM role)
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
unzip awscliv2.zip && sudo ./aws/install
aws sts get-caller-identity   # should succeed with NO credentials configured — proves the IAM role works

# kubectl
curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
sudo install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl

# Trivy
sudo apt install -y wget apt-transport-https gnupg
wget -qO - https://aquasecurity.github.io/trivy-repo/deb/public.key | sudo apt-key add -
echo "deb https://aquasecurity.github.io/trivy-repo/deb $(lsb_release -sc) main" | sudo tee -a /etc/apt/sources.list.d/trivy.list
sudo apt update && sudo apt install -y trivy

# sonar-scanner CLI
wget https://binaries.sonarsource.com/Distribution/sonar-scanner-cli/sonar-scanner-cli-5.0.1.3006-linux.zip
unzip sonar-scanner-cli-*.zip -d /opt && sudo ln -s /opt/sonar-scanner-*/bin/sonar-scanner /usr/local/bin/sonar-scanner

sudo systemctl restart jenkins
```

### 4.4 Jenkins credentials (Manage Jenkins → Credentials → System → Global)
| ID | Type | Value |
|---|---|---|
| `aws-account-id` | Secret text | Your 12-digit AWS account ID (used to build the ECR registry URL) |
| `sonarqube-token` | Secret text | SonarQube user token |
| `sonarqube-host-url` | Secret text | e.g. `http://<sonarqube-ec2-ip>:9000` |
| `kubeconfig-kubespray` | Secret file | The `~/.kube/config` fetched in §3.2 |

Notice there's **no Docker Hub credential** — ECR auth flows entirely through the IAM role attached
to the EC2 instance (§2.2).

### 4.5 Configure the SonarQube server in Jenkins
Manage Jenkins → System → SonarQube servers → Add:
- Name: `sonarqube-server` (must match `withSonarQubeEnv('sonarqube-server')` in the Jenkinsfile)
- Server URL + token from above

### 4.6 Create the Pipeline job
New Item → Pipeline (or Multibranch Pipeline) → Pipeline script from SCM → Git → your repo →
Script Path: `Jenkinsfile` → Build Triggers → check **GitHub hook trigger for GITScm polling**.

### 4.7 GitHub webhook
GitHub repo → Settings → Webhooks → Add webhook:
- Payload URL: `http://<jenkins-ec2-public-ip>:8080/github-webhook/`
- Content type: `application/json`
- Events: push + pull request

### 4.8 Build notifications
Configure SMTP under Manage Jenkins → System → Extended E-mail Notification to enable the
`emailext` calls in the Jenkinsfile's `post` block.

---

## 5. SonarQube Setup

### 5.1 Run SonarQube
```bash
# On the SonarQube EC2 instance
docker run -d --name sonarqube -p 9000:9000 \
  -e SONAR_WEB_JAVAOPTS="-Djava.security.manager=allow" \
  sonarqube:lts-community
```
The `-Djava.security.manager=allow` flag avoids a startup crash on newer JVMs where the
`SecurityManager` was deprecated/removed.

Login at `http://<sonarqube-ec2-ip>:9000` with `admin/admin`, set a new password.

### 5.2 Generate a token
My Account → Security → Generate Token → save as the `sonarqube-token` Jenkins credential.

### 5.3 Configure the Quality Gate
Quality Gates → set thresholds appropriate to your project's actual scope — don't just accept the
default "Sonar way" blindly. A reasonable custom gate for this project:
- Zero new Bugs, zero new Vulnerabilities on New Code
- Maintainability Rating on New Code = A
- (If you have a full test suite) Coverage on New Code ≥ 80% — otherwise it's fine to exclude
  coverage from the gate and rely on the zero-new-bugs/vulnerabilities rule instead

### 5.4 Webhook back to Jenkins (required for `waitForQualityGate`)
SonarQube → Administration → Configuration → Webhooks → Add:
- URL: `http://<jenkins-ec2-public-ip>:8080/sonarqube-webhook/`

Without this webhook, `waitForQualityGate` will hang and eventually time out.

---

## 6. Containerization

- `app/backend/Dockerfile` — 3-stage build: install deps + run tests, install prod-only deps, copy
  into a minimal `node:20-alpine` runtime as a non-root user.
- `app/frontend/Dockerfile` — build stage prepares static assets, runtime stage serves via
  `nginx:1.27-alpine` as a non-root user.

### Image versioning strategy
Every image gets two tags: `v1.<BUILD_NUMBER>-<GIT_SHORT_SHA>` (immutable, traceable) and `latest`.

Local build/test before touching AWS at all:
```bash
docker build -t capstone-backend:local ./app/backend
docker build -t capstone-frontend:local ./app/frontend
docker compose up --build
# frontend: http://localhost:8080  backend: http://localhost:5000/api/version
```

---

## 7. Kubernetes Deployment

| File | Resource | Purpose |
|---|---|---|
| `k8s/namespace.yaml` | Namespace | Isolates the app (`capstone1`) |
| `k8s/configmap.yaml` | ConfigMap | Non-secret env config (DB host, API base URL...) |
| `k8s/secret.yaml` | Secret | DB credentials, JWT secret |
| `k8s/backend-deployment.yaml` | Deployment | Rolling update, probes, resource limits, `imagePullSecrets: ecr-secret` |
| `k8s/backend-service.yaml` | Service (ClusterIP) | Stable internal DNS name for the API |
| `k8s/frontend-deployment.yaml` | Deployment | Rolling update, probes, `imagePullSecrets: ecr-secret` |
| `k8s/frontend-service.yaml` | Service (ClusterIP) | Stable internal DNS name for the UI |
| `k8s/mysql-statefulset.yaml` | StatefulSet + headless Service | Tier 3 database with PVC |
| `k8s/ingress.yaml` | Ingress | Routes `/` → frontend, `/api` → backend |
| `k8s/hpa.yaml` | HorizontalPodAutoscaler | Scales pods on CPU > 70% |

### 7.1 The ECR pull secret (why it's needed)
EC2's IAM role gives the **Jenkins host** permission to push to ECR — but Kubernetes nodes (kubelet)
do **not** automatically inherit that role for pulling images. So every Deployment references an
`imagePullSecrets: ecr-secret`, and the Jenkinsfile's **Refresh ECR Pull Secret** stage recreates that
Secret from a fresh token on every single deploy:
```bash
kubectl delete secret ecr-secret -n capstone1 --ignore-not-found
kubectl create secret docker-registry ecr-secret \
  --docker-server=<account-id>.dkr.ecr.<region>.amazonaws.com \
  --docker-username=AWS \
  --docker-password=$(aws ecr get-login-password --region <region>) \
  --namespace=capstone1
```
ECR tokens expire after ~12 hours, so if you deploy manually and it's been a while, refresh this
secret by hand before troubleshooting `ImagePullBackOff`.

### 7.2 First-time manual apply
Before Jenkins runs the flow, and before your images even exist in ECR, apply the namespace/DB/config
by hand once so you can watch it all start correctly:
```bash
kubectl apply -f k8s/namespace.yaml
kubectl apply -n capstone1 -f k8s/configmap.yaml
kubectl apply -n capstone1 -f k8s/secret.yaml
kubectl apply -n capstone1 -f k8s/mysql-statefulset.yaml

# create the ECR pull secret manually the first time
kubectl create secret docker-registry ecr-secret \
  --docker-server=<account-id>.dkr.ecr.<region>.amazonaws.com \
  --docker-username=AWS \
  --docker-password=$(aws ecr get-login-password --region <region>) \
  --namespace=capstone1

kubectl apply -n capstone1 -f k8s/backend-deployment.yaml
kubectl apply -n capstone1 -f k8s/backend-service.yaml
kubectl apply -n capstone1 -f k8s/frontend-deployment.yaml
kubectl apply -n capstone1 -f k8s/frontend-service.yaml
kubectl apply -n capstone1 -f k8s/ingress.yaml
kubectl apply -n capstone1 -f k8s/hpa.yaml

kubectl get pods -n capstone1 -w
```
Before this will work you must have already pushed at least one image tag to each ECR repo
(§4.3's `aws ecr create-repository` + a manual `docker push`, or just let Jenkins do the first build).

Also **before applying the deployments**, replace the placeholder image lines in
`k8s/backend-deployment.yaml` and `k8s/frontend-deployment.yaml`:
```yaml
image: <AWS_ACCOUNT_ID>.dkr.ecr.<AWS_REGION>.amazonaws.com/capstone1-backend:latest
```
with your real account ID and region.

Find the ingress-nginx NodePort and browse to any node's public IP on that port:
```bash
kubectl get svc -n ingress-nginx ingress-nginx-controller
```

### 7.3 Zero-downtime rolling updates
`maxUnavailable: 0` + `maxSurge: 1` + readiness probes mean Kubernetes only shifts traffic to a new
pod once it passes `/health/ready`, never dropping below the desired replica count mid-update.

### 7.4 Rollback strategy
Manual:
```bash
kubectl rollout history deployment/backend-deployment -n capstone1
kubectl rollout undo deployment/backend-deployment -n capstone1
kubectl rollout undo deployment/backend-deployment -n capstone1 --to-revision=<N>
```
Automatic: the Jenkinsfile's `post { failure { ... } }` block runs `kubectl rollout undo` for both
deployments the moment a rollout or smoke test fails.

---

## 8. High Availability Checklist

- ✅ **ReplicaSets** — Deployments maintain multiple pods (`replicas: 3`)
- ✅ **Rolling Updates** — `RollingUpdate` strategy, `maxUnavailable: 0`
- ✅ **Readiness probes** — `/health/ready` (checks live DB connectivity), `/health` (frontend)
- ✅ **Liveness probes** — `/health/live` restarts a hung container automatically
- ✅ **HPA** — auto-scales both tiers under load (requires metrics-server)
- ⚠️ **MySQL is single-replica**, not a true HA StatefulSet — an accepted simplification at this
  project's scope. Call this out explicitly as a known limitation rather than hiding it.

---

## 9. End-to-End Walkthrough (demo script)

1. `git checkout -b feature/demo-change` → edit `app/backend/src/server.js` → commit → push → open PR.
2. Jenkins auto-builds via webhook → tests → SonarQube → Quality Gate.
3. On merge, pipeline builds Docker images, scans with Trivy, pushes to ECR, refreshes `ecr-secret`.
4. Pipeline runs `kubectl set image` → watch the rolling update:
   ```bash
   kubectl get pods -n capstone1 -w
   ```
5. Verify zero downtime by hammering the endpoint during a deploy (replace with your ingress URL):
   ```bash
   while true; do curl -s -o /dev/null -w "%{http_code}\n" http://<node-public-ip>:<nodeport>/api/version; sleep 0.5; done
   ```
6. Force a bad deploy on purpose (e.g. push a broken image tag) and watch the automatic rollback fire
   in the `post { failure }` block.

---

## 10. Troubleshooting Reference (common real-world issues)

| Symptom | Cause | Fix |
|---|---|---|
| Jenkins repo signature errors on `apt update` | Jenkins rotated its signing key | Use the current key/repo path from §4.1 |
| Jenkins service won't start | Wrong Java version installed | Install `openjdk-21-jre`, not 17 |
| SonarQube container crashes on boot | `SecurityManager` deprecated in newer JVMs | Add `-Djava.security.manager=allow` (§5.1) |
| `waitForQualityGate` hangs / times out | No SonarQube → Jenkins webhook | Add the webhook (§5.4) |
| Pods stuck `ImagePullBackOff` | kubelet doesn't inherit the EC2 IAM role | Create/refresh `ecr-secret` (§7.1) |
| MySQL PVC stuck `Pending` | No default StorageClass on Kubespray | Install `local-path-provisioner` (§3.4) |
| Frontend loads, API calls fail | Hardcoded `localhost` API URL in the build | Use relative paths / runtime `env.js` (already done in this scaffold) |
| API calls return HTML 404s | Stray Ingress `rewrite-target` mangling `/api` | Remove unnecessary rewrite annotations |
| Backend intermittently fails DB queries | Single long-lived MySQL connection, no reconnect | Use a connection pool (already done via `mysql2.createPool`) |
| SonarQube gate fails on IaC rules | Missing resource requests/limits in manifests | Already set on every container in this scaffold |
| New pods `ImagePullBackOff` mid-pipeline hours later | ECR tokens expire ~12h | Pipeline refreshes `ecr-secret` on every deploy (already built in) |

---

## 11. Deliverables Map

| Deliverable | Location |
|---|---|
| GitHub Repository | this repo (push it to GitHub per §1.1) |
| Jenkinsfile | [`Jenkinsfile`](Jenkinsfile) |
| Dockerfile(s) | [`app/backend/Dockerfile`](app/backend/Dockerfile), [`app/frontend/Dockerfile`](app/frontend/Dockerfile) |
| Kubernetes YAMLs | [`k8s/`](k8s/) |
| Deployment Architecture | [`docs/architecture.md`](docs/architecture.md) |
| CI/CD Flow Diagram | [`docs/cicd-flow.md`](docs/cicd-flow.md) |
