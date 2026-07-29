pipeline {

    agent any

    options {
        timestamps()
        buildDiscarder(logRotator(numToKeepStr: '20'))
        disableConcurrentBuilds()
        timeout(time: 45, unit: 'MINUTES')
    }

    parameters {
        choice(name: 'ENVIRONMENT', choices: ['dev', 'staging', 'prod'], description: 'Target environment / namespace')
    }

    environment {
        AWS_REGION              = 'ap-south-1'
        AWS_ACCOUNT_ID          = credentials('aws-account-id')
        ECR_REGISTRY            = "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
        BACKEND_IMAGE           = "${ECR_REGISTRY}/capstone1-backend"
        FRONTEND_IMAGE          = "${ECR_REGISTRY}/capstone1-frontend"

        GIT_SHORT_SHA           = "${GIT_COMMIT.take(7)}"
        IMAGE_TAG               = "v1.${BUILD_NUMBER}-${GIT_SHORT_SHA}"

        SONAR_PROJECT_KEY       = 'capstone-cicd-platform'
        SONAR_HOST_URL          = credentials('sonarqube-host-url')
        SONAR_TOKEN             = credentials('sonarqube-token')

        KUBECONFIG_CRED         = credentials('kubeconfig-kubespray')
        K8S_NAMESPACE           = "capstone1"
    }

    stages {

        stage('Checkout') {
            steps {
                checkout scm
                script {
                    env.GIT_BRANCH_NAME = env.GIT_BRANCH ?: sh(script: 'git rev-parse --abbrev-ref HEAD', returnStdout: true).trim()
                }
                echo "Checked out branch: ${env.GIT_BRANCH_NAME}, commit: ${env.GIT_SHORT_SHA}"
            }
        }

        stage('Install & Unit Test (Backend)') {
            steps {
                dir('app/backend') {
                    sh '''
                        npm ci
                        npm test -- --ci --coverage --coverageReporters=lcov --coverageReporters=text
                    '''
                }
            }
            post {
                always {
                    junit allowEmptyResults: true, testResults: 'app/backend/junit.xml'
                }
            }
        }

        stage('SonarQube Analysis') {
            steps {
                dir('app/backend') {
                    withSonarQubeEnv('sonarqube-server') {
                        sh """
                            sonar-scanner \
                              -Dsonar.projectKey=${SONAR_PROJECT_KEY} \
                              -Dsonar.sources=src \
                              -Dsonar.tests=src \
                              -Dsonar.test.inclusions=**/*.test.js \
                              -Dsonar.javascript.lcov.reportPaths=coverage/lcov.info \
                              -Dsonar.host.url=${SONAR_HOST_URL} \
                              -Dsonar.login=${SONAR_TOKEN}
                        """
                    }
                }
            }
        }

        stage('Quality Gate') {
            steps {
                timeout(time: 10, unit: 'MINUTES') {
                    waitForQualityGate abortPipeline: true
                }
            }
        }

        stage('Docker Build') {
            parallel {
                stage('Build Backend Image') {
                    steps {
                        dir('app/backend') {
                            sh """
                                docker build \
                                  --build-arg BUILD_NUMBER=${BUILD_NUMBER} \
                                  --build-arg APP_VERSION=${IMAGE_TAG} \
                                  -t ${BACKEND_IMAGE}:${IMAGE_TAG} \
                                  -t ${BACKEND_IMAGE}:latest .
                            """
                        }
                    }
                }
                stage('Build Frontend Image') {
                    steps {
                        dir('app/frontend') {
                            sh """
                                docker build \
                                  -t ${FRONTEND_IMAGE}:${IMAGE_TAG} \
                                  -t ${FRONTEND_IMAGE}:latest .
                            """
                        }
                    }
                }
            }
        }

        stage('Image Vulnerability Scan') {
            steps {
                sh """
                    trivy image --severity HIGH,CRITICAL --exit-code 1 --no-progress ${BACKEND_IMAGE}:${IMAGE_TAG} || \
                    (echo 'Vulnerabilities found in backend image' && exit 1)
                    trivy image --severity HIGH,CRITICAL --exit-code 1 --no-progress ${FRONTEND_IMAGE}:${IMAGE_TAG} || \
                    (echo 'Vulnerabilities found in frontend image' && exit 1)
                """
            }
        }

        stage('Push to Amazon ECR') {
            steps {
                sh """
                    aws ecr get-login-password --region ${AWS_REGION} | \
                      docker login --username AWS --password-stdin ${ECR_REGISTRY}

                    aws ecr describe-repositories --repository-names capstone1-backend --region ${AWS_REGION} || \
                      aws ecr create-repository --repository-name capstone1-backend --region ${AWS_REGION}
                    aws ecr describe-repositories --repository-names capstone1-frontend --region ${AWS_REGION} || \
                      aws ecr create-repository --repository-name capstone1-frontend --region ${AWS_REGION}

                    docker push ${BACKEND_IMAGE}:${IMAGE_TAG}
                    docker push ${BACKEND_IMAGE}:latest
                    docker push ${FRONTEND_IMAGE}:${IMAGE_TAG}
                    docker push ${FRONTEND_IMAGE}:latest
                    docker logout ${ECR_REGISTRY}
                """
            }
        }

        stage('Refresh ECR Pull Secret') {
            steps {
                withEnv(["KUBECONFIG=${KUBECONFIG_CRED}"]) {
                    sh """
                        kubectl create namespace ${K8S_NAMESPACE} --dry-run=client -o yaml | kubectl apply -f -

                        kubectl delete secret ecr-secret -n ${K8S_NAMESPACE} --ignore-not-found

                        kubectl create secret docker-registry ecr-secret \
                          --docker-server=${ECR_REGISTRY} \
                          --docker-username=AWS \
                          --docker-password=\$(aws ecr get-login-password --region ${AWS_REGION}) \
                          --namespace=${K8S_NAMESPACE}
                    """
                }
            }
        }

        stage('Deploy to Kubernetes') {
            steps {
                withEnv(["KUBECONFIG=${KUBECONFIG_CRED}"]) {
                    sh """
                        kubectl apply -n ${K8S_NAMESPACE} -f k8s/configmap.yaml
                        kubectl apply -n ${K8S_NAMESPACE} -f k8s/secret.yaml
                        kubectl apply -n ${K8S_NAMESPACE} -f k8s/mysql-statefulset.yaml
                        kubectl apply -n ${K8S_NAMESPACE} -f k8s/backend-deployment.yaml
                        kubectl apply -n ${K8S_NAMESPACE} -f k8s/backend-service.yaml
                        kubectl apply -n ${K8S_NAMESPACE} -f k8s/frontend-deployment.yaml
                        kubectl apply -n ${K8S_NAMESPACE} -f k8s/frontend-service.yaml
                        kubectl apply -n ${K8S_NAMESPACE} -f k8s/ingress.yaml
                        kubectl apply -n ${K8S_NAMESPACE} -f k8s/hpa.yaml

                        kubectl set image deployment/backend-deployment backend=${BACKEND_IMAGE}:${IMAGE_TAG} -n ${K8S_NAMESPACE}
                        kubectl set image deployment/frontend-deployment frontend=${FRONTEND_IMAGE}:${IMAGE_TAG} -n ${K8S_NAMESPACE}

                        kubectl rollout status deployment/backend-deployment -n ${K8S_NAMESPACE} --timeout=180s
                        kubectl rollout status deployment/frontend-deployment -n ${K8S_NAMESPACE} --timeout=180s
                    """
                }
            }
        }

        stage('Smoke Test') {
            steps {
                withEnv(["KUBECONFIG=${KUBECONFIG_CRED}"]) {
                    sh """
                        SVC_IP=\$(kubectl get svc backend-service -n ${K8S_NAMESPACE} -o jsonpath='{.spec.clusterIP}')
                        kubectl run smoke-test-${BUILD_NUMBER} --rm -i --restart=Never --image=curlimages/curl -n ${K8S_NAMESPACE} -- \
                          curl -sf http://\$SVC_IP:5000/health/ready
                    """
                }
            }
        }
    }

    post {
        failure {
            echo 'Pipeline failed — rolling back to previous stable revision.'
            withEnv(["KUBECONFIG=${KUBECONFIG_CRED}"]) {
                sh """
                    kubectl rollout undo deployment/backend-deployment -n ${K8S_NAMESPACE} || true
                    kubectl rollout undo deployment/frontend-deployment -n ${K8S_NAMESPACE} || true
                """
            }
            emailext(
                subject: "FAILED: Job '${JOB_NAME} [${BUILD_NUMBER}]'",
                body: "Build failed and was rolled back automatically. Check console output: ${BUILD_URL}",
                to: 'abhijith.devops@gmail.com'
            )
        }
        success {
            emailext(
                subject: "SUCCESS: Job '${JOB_NAME} [${BUILD_NUMBER}]' - ${IMAGE_TAG}",
                body: "Deployed ${IMAGE_TAG} to ${K8S_NAMESPACE} successfully. ${BUILD_URL}",
                to: 'abhijith.devops@gmail.com'
            )
        }
        always {
            sh 'docker system prune -f || true'
            cleanWs()
        }
    }
}
