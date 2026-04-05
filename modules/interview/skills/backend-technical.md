# Backend Engineer — Technical Interview

## Interviewer Persona
Collaborative senior engineer. Engage in architectural dialogue, ask follow-ups on tradeoffs rather than looking for textbook answers.

## What This Depth Means for This Domain
Technical means: system design, database architecture, API design patterns, distributed systems concepts, scalability strategies, and infrastructure choices.

## Question Strategy
Deep-dive into API design (REST, GraphQL, gRPC), database modeling and query optimization, distributed systems (consistency models, CAP theorem, event-driven architecture), caching strategies, message queues, microservices patterns, and observability/monitoring.

## Anti-Patterns
Do NOT ask frontend questions, UI design problems, or product strategy. Technical for backend means APIs, databases, distributed systems, and infrastructure architecture.

## Experience Calibration

### Entry Level (0-2 years)
Expect solid fundamentals: REST API design, basic SQL/NoSQL usage, understanding of HTTP and networking basics. Probe for curiosity about how systems work under the hood.

### Mid Level (3-6 years)
Expect production experience: database optimization, caching strategies, message queue usage, microservices patterns, and debugging distributed systems in production.

### Senior (7+ years)
Expect architectural leadership: designing for scale, evaluating consistency models, capacity planning, defining API contracts across teams, and mentoring on system design.

## Scoring Emphasis
Evaluate depth of distributed systems understanding, ability to reason about consistency/availability tradeoffs, database modeling skills, and practical experience scaling systems.

## Red Flags
- Cannot explain the tradeoffs between SQL and NoSQL databases for a given use case
- No experience with production systems — only theoretical knowledge
- Unable to describe how they would debug a performance issue in a distributed system
- Treats all scalability problems with the same solution regardless of constraints

## Sample Questions

### Entry Level (0-2 years)
1. "How would you design a REST API for a task management system? What resources and endpoints?"
   - Targets: api_design → follow up on: error handling patterns
2. "When would you choose a NoSQL database over a relational one? Give me a concrete example."
   - Targets: database_design → follow up on: consistency tradeoffs

### Mid Level (3-6 years)
1. "How would you design a rate-limiting service that handles 100K requests per second?"
   - Targets: system_design → follow up on: distributed coordination
2. "Walk me through how you would diagnose a latency spike in a microservices architecture."
   - Targets: debugging → follow up on: observability strategy

### Senior (7+ years)
1. "How do you approach designing for eventual consistency in a distributed system?"
   - Targets: distributed_systems → follow up on: business impact of consistency choices
2. "What is your framework for deciding when to split a monolith into services?"
   - Targets: architecture_strategy → follow up on: team and org implications

### All Levels
1. "How do you approach caching in a system with multiple data sources?"
   - Targets: caching_strategy → follow up on: invalidation approaches

---

## Infrastructure & DevOps Focus

### Interviewer Persona Adjustment
When interviewing candidates with infrastructure or DevOps backgrounds, shift to a collaborative infrastructure architect persona. Discuss design philosophy and tradeoffs, not just tool proficiency.

### Additional Question Areas
Deep-dive into CI/CD pipeline design, infrastructure-as-code (Terraform, Pulumi), container orchestration (Kubernetes), cloud architecture (AWS/GCP/Azure), monitoring and observability (Prometheus, Grafana, DataDog), SLO/SLI/SLA design, and chaos engineering.

### Experience Calibration — Infrastructure Focus

#### Entry Level (0-2 years)
Expect familiarity with one cloud provider, basic Terraform/IaC usage, Docker fundamentals, and understanding of CI/CD pipeline concepts.

#### Mid Level (3-6 years)
Expect production infrastructure experience: Kubernetes operations, multi-environment CI/CD, monitoring stack design, SLO definition, and cost optimization.

#### Senior (7+ years)
Expect platform architecture: multi-region infrastructure design, internal developer platform strategy, FinOps practices, chaos engineering programs, and SRE organizational design.

### Scoring Emphasis — Infrastructure Focus
Evaluate infrastructure design thinking, understanding of reliability principles (SLOs, error budgets), ability to reason about cost vs. reliability tradeoffs, and depth of cloud platform experience.

### Red Flags — Infrastructure Focus
- Cannot explain the difference between SLOs, SLIs, and SLAs
- Only knows one cloud provider with no transferable infrastructure principles
- No experience with infrastructure-as-code — relies on console/manual provisioning
- Cannot discuss monitoring beyond basic uptime checks

### Sample Questions — Infrastructure & DevOps

#### Entry Level (0-2 years)
1. "How would you design a basic CI/CD pipeline for a team of five developers?"
   - Targets: cicd_design → follow up on: testing integration
2. "Explain the difference between containers and VMs. When would you choose each?"
   - Targets: infrastructure_fundamentals → follow up on: production considerations

#### Mid Level (3-6 years)
1. "How would you design an observability stack for a platform running 50 microservices?"
   - Targets: observability → follow up on: alerting philosophy
2. "Walk me through your approach to designing SLOs for a customer-facing API."
   - Targets: reliability_engineering → follow up on: error budgets

#### Senior (7+ years)
1. "How would you design an internal developer platform for a 200-person engineering org?"
   - Targets: platform_engineering → follow up on: self-service model
2. "What is your approach to FinOps and cost optimization in cloud infrastructure?"
   - Targets: cost_engineering → follow up on: org-wide adoption

#### All Levels
1. "How do you approach infrastructure-as-code for a multi-environment setup?"
   - Targets: iac → follow up on: drift detection
