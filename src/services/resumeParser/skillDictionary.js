'use strict';

/**
 * skillDictionary.js
 *
 * 500+ skills organised by category with normalization aliases.
 * Each entry: { canonical, aliases[], category }
 *
 * Detection: check if any alias OR canonical appears in lowercased resume text.
 * Normalization: always return the canonical display name.
 */

const SKILL_ENTRIES = [
  // ── Programming Languages ─────────────────────────────────────────────────
  { canonical: 'JavaScript',    aliases: ['javascript', 'js', 'ecmascript', 'es6', 'es2015'],     category: 'Programming' },
  { canonical: 'TypeScript',    aliases: ['typescript', 'ts'],                                     category: 'Programming' },
  { canonical: 'Python',        aliases: ['python', 'python3', 'python2'],                         category: 'Programming' },
  { canonical: 'Java',          aliases: ['java', 'java 8', 'java 11', 'java 17'],                 category: 'Programming' },
  { canonical: 'C++',           aliases: ['c++', 'cpp', 'c plus plus'],                           category: 'Programming' },
  { canonical: 'C#',            aliases: ['c#', 'csharp', 'c sharp', '.net c#'],                   category: 'Programming' },
  { canonical: 'C',             aliases: [' c ', 'c language', 'ansi c'],                          category: 'Programming' },
  { canonical: 'Go',            aliases: ['golang', ' go ', 'go lang'],                            category: 'Programming' },
  { canonical: 'Rust',          aliases: ['rust', 'rust-lang'],                                    category: 'Programming' },
  { canonical: 'Swift',         aliases: ['swift', 'swift 5'],                                     category: 'Programming' },
  { canonical: 'Kotlin',        aliases: ['kotlin'],                                               category: 'Programming' },
  { canonical: 'PHP',           aliases: ['php', 'php7', 'php8'],                                  category: 'Programming' },
  { canonical: 'Ruby',          aliases: ['ruby', 'ruby on rails'],                                category: 'Programming' },
  { canonical: 'Scala',         aliases: ['scala'],                                                category: 'Programming' },
  { canonical: 'R',             aliases: [' r ', 'r language', 'r programming', 'rstudio'],        category: 'Programming' },
  { canonical: 'MATLAB',        aliases: ['matlab'],                                               category: 'Programming' },
  { canonical: 'Perl',          aliases: ['perl'],                                                 category: 'Programming' },
  { canonical: 'Shell',         aliases: ['bash', 'shell scripting', 'shell script', 'zsh', 'ksh'], category: 'Programming' },
  { canonical: 'PowerShell',    aliases: ['powershell', 'ps1'],                                   category: 'Programming' },
  { canonical: 'VBA',           aliases: ['vba', 'visual basic for applications', 'vba macros'],  category: 'Programming' },
  { canonical: 'Dart',          aliases: ['dart'],                                                 category: 'Programming' },
  { canonical: 'Elixir',        aliases: ['elixir'],                                               category: 'Programming' },
  { canonical: 'Haskell',       aliases: ['haskell'],                                             category: 'Programming' },
  { canonical: 'Assembly',      aliases: ['assembly', 'asm', 'x86', 'x64'],                       category: 'Programming' },
  { canonical: 'COBOL',         aliases: ['cobol'],                                               category: 'Programming' },
  { canonical: 'Fortran',       aliases: ['fortran'],                                             category: 'Programming' },

  // ── Web Frontend ──────────────────────────────────────────────────────────
  { canonical: 'React',         aliases: ['react', 'reactjs', 'react.js', 'react js'],            category: 'Frontend' },
  { canonical: 'Vue.js',        aliases: ['vue', 'vuejs', 'vue.js', 'vue js', 'vue 3'],           category: 'Frontend' },
  { canonical: 'Angular',       aliases: ['angular', 'angularjs', 'angular.js', 'angular 2', 'angular 15'], category: 'Frontend' },
  { canonical: 'Next.js',       aliases: ['next.js', 'nextjs', 'next js'],                        category: 'Frontend' },
  { canonical: 'Nuxt.js',       aliases: ['nuxt', 'nuxtjs', 'nuxt.js'],                           category: 'Frontend' },
  { canonical: 'Svelte',        aliases: ['svelte', 'sveltekit'],                                 category: 'Frontend' },
  { canonical: 'HTML',          aliases: ['html', 'html5', 'html 5'],                             category: 'Frontend' },
  { canonical: 'CSS',           aliases: ['css', 'css3', 'css 3'],                               category: 'Frontend' },
  { canonical: 'Tailwind CSS',  aliases: ['tailwind', 'tailwindcss', 'tailwind css'],             category: 'Frontend' },
  { canonical: 'Bootstrap',     aliases: ['bootstrap', 'bootstrap 5', 'twitter bootstrap'],       category: 'Frontend' },
  { canonical: 'SASS',          aliases: ['sass', 'scss'],                                        category: 'Frontend' },
  { canonical: 'Redux',         aliases: ['redux', 'redux toolkit', 'react redux'],               category: 'Frontend' },
  { canonical: 'Webpack',       aliases: ['webpack'],                                             category: 'Frontend' },
  { canonical: 'Vite',          aliases: ['vite', 'vitejs'],                                      category: 'Frontend' },
  { canonical: 'jQuery',        aliases: ['jquery', 'jquery ui'],                                 category: 'Frontend' },
  { canonical: 'Flutter',       aliases: ['flutter'],                                             category: 'Frontend' },
  { canonical: 'React Native',  aliases: ['react native', 'react-native'],                        category: 'Frontend' },
  { canonical: 'GraphQL',       aliases: ['graphql', 'gql', 'apollo graphql', 'apollo'],          category: 'Frontend' },

  // ── Backend / Node ────────────────────────────────────────────────────────
  { canonical: 'Node.js',       aliases: ['node.js', 'nodejs', 'node js', 'node'],                category: 'Backend' },
  { canonical: 'Express.js',    aliases: ['express', 'expressjs', 'express.js'],                  category: 'Backend' },
  { canonical: 'NestJS',        aliases: ['nestjs', 'nest.js', 'nest js'],                        category: 'Backend' },
  { canonical: 'Django',        aliases: ['django', 'django rest framework', 'drf'],              category: 'Backend' },
  { canonical: 'Flask',         aliases: ['flask'],                                               category: 'Backend' },
  { canonical: 'FastAPI',       aliases: ['fastapi', 'fast api'],                                 category: 'Backend' },
  { canonical: 'Spring Boot',   aliases: ['spring boot', 'spring', 'springboot'],                 category: 'Backend' },
  { canonical: 'Laravel',       aliases: ['laravel'],                                             category: 'Backend' },
  { canonical: 'Rails',         aliases: ['rails', 'ruby on rails', 'ror'],                       category: 'Backend' },
  { canonical: 'ASP.NET',       aliases: ['asp.net', 'asp net', 'dotnet', '.net', 'net core'],    category: 'Backend' },
  { canonical: 'Microservices', aliases: ['microservices', 'micro-services', 'microservice architecture'], category: 'Backend' },
  { canonical: 'REST API',      aliases: ['rest api', 'restful api', 'rest', 'restful', 'api development'], category: 'Backend' },
  { canonical: 'gRPC',          aliases: ['grpc', 'g-rpc'],                                      category: 'Backend' },
  { canonical: 'WebSockets',    aliases: ['websockets', 'websocket', 'socket.io'],                category: 'Backend' },
  { canonical: 'Kafka',         aliases: ['kafka', 'apache kafka'],                              category: 'Backend' },
  { canonical: 'RabbitMQ',      aliases: ['rabbitmq', 'rabbit mq'],                              category: 'Backend' },
  { canonical: 'Redis',         aliases: ['redis', 'redis cache'],                               category: 'Backend' },

  // ── Databases ─────────────────────────────────────────────────────────────
  { canonical: 'SQL',           aliases: ['sql', 'structured query language'],                    category: 'Databases' },
  { canonical: 'MySQL',         aliases: ['mysql', 'my sql'],                                    category: 'Databases' },
  { canonical: 'PostgreSQL',    aliases: ['postgresql', 'postgres', 'pg'],                        category: 'Databases' },
  { canonical: 'MongoDB',       aliases: ['mongodb', 'mongo db', 'mongo'],                        category: 'Databases' },
  { canonical: 'SQLite',        aliases: ['sqlite', 'sqlite3'],                                  category: 'Databases' },
  { canonical: 'Oracle DB',     aliases: ['oracle', 'oracle database', 'oracle db', 'oracle sql'], category: 'Databases' },
  { canonical: 'SQL Server',    aliases: ['sql server', 'mssql', 'ms sql', 'microsoft sql server', 't-sql'], category: 'Databases' },
  { canonical: 'Firebase',      aliases: ['firebase', 'firestore', 'firebase realtime'],          category: 'Databases' },
  { canonical: 'DynamoDB',      aliases: ['dynamodb', 'dynamo db'],                              category: 'Databases' },
  { canonical: 'Cassandra',     aliases: ['cassandra', 'apache cassandra'],                      category: 'Databases' },
  { canonical: 'Elasticsearch', aliases: ['elasticsearch', 'elastic search', 'opensearch'],      category: 'Databases' },
  { canonical: 'Neo4j',         aliases: ['neo4j', 'graph database'],                            category: 'Databases' },
  { canonical: 'Supabase',      aliases: ['supabase'],                                           category: 'Databases' },

  // ── Cloud ─────────────────────────────────────────────────────────────────
  { canonical: 'AWS',           aliases: ['aws', 'amazon web services', 'amazon aws'],            category: 'Cloud' },
  { canonical: 'Azure',         aliases: ['azure', 'microsoft azure', 'ms azure'],               category: 'Cloud' },
  { canonical: 'GCP',           aliases: ['gcp', 'google cloud', 'google cloud platform'],       category: 'Cloud' },
  { canonical: 'AWS Lambda',    aliases: ['lambda', 'aws lambda', 'serverless functions'],       category: 'Cloud' },
  { canonical: 'AWS S3',        aliases: ['s3', 'aws s3', 'amazon s3'],                          category: 'Cloud' },
  { canonical: 'AWS EC2',       aliases: ['ec2', 'aws ec2'],                                    category: 'Cloud' },
  { canonical: 'AWS RDS',       aliases: ['rds', 'aws rds'],                                    category: 'Cloud' },
  { canonical: 'CloudFormation',aliases: ['cloudformation', 'cloud formation'],                  category: 'Cloud' },
  { canonical: 'Terraform',     aliases: ['terraform', 'hcl'],                                   category: 'Cloud' },
  { canonical: 'Serverless',    aliases: ['serverless', 'faas', 'function as a service'],         category: 'Cloud' },
  { canonical: 'Heroku',        aliases: ['heroku'],                                             category: 'Cloud' },
  { canonical: 'Vercel',        aliases: ['vercel'],                                             category: 'Cloud' },
  { canonical: 'DigitalOcean',  aliases: ['digitalocean', 'digital ocean'],                      category: 'Cloud' },
  { canonical: 'Cloudflare',    aliases: ['cloudflare'],                                         category: 'Cloud' },

  // ── DevOps & CI/CD ────────────────────────────────────────────────────────
  { canonical: 'Docker',        aliases: ['docker', 'dockerfile', 'docker compose'],              category: 'DevOps' },
  { canonical: 'Kubernetes',    aliases: ['kubernetes', 'k8s', 'kubectl'],                        category: 'DevOps' },
  { canonical: 'Jenkins',       aliases: ['jenkins', 'jenkins ci'],                              category: 'DevOps' },
  { canonical: 'GitHub Actions',aliases: ['github actions', 'gh actions'],                       category: 'DevOps' },
  { canonical: 'GitLab CI',     aliases: ['gitlab ci', 'gitlab-ci', 'gitlab ci/cd'],             category: 'DevOps' },
  { canonical: 'CircleCI',      aliases: ['circleci', 'circle ci'],                              category: 'DevOps' },
  { canonical: 'Ansible',       aliases: ['ansible'],                                            category: 'DevOps' },
  { canonical: 'Puppet',        aliases: ['puppet'],                                             category: 'DevOps' },
  { canonical: 'Chef',          aliases: ['chef'],                                               category: 'DevOps' },
  { canonical: 'Prometheus',    aliases: ['prometheus'],                                         category: 'DevOps' },
  { canonical: 'Grafana',       aliases: ['grafana'],                                            category: 'DevOps' },
  { canonical: 'Git',           aliases: ['git', 'version control'],                             category: 'DevOps' },
  { canonical: 'GitHub',        aliases: ['github'],                                             category: 'DevOps' },
  { canonical: 'GitLab',        aliases: ['gitlab'],                                             category: 'DevOps' },
  { canonical: 'Bitbucket',     aliases: ['bitbucket'],                                          category: 'DevOps' },
  { canonical: 'CI/CD',         aliases: ['ci/cd', 'continuous integration', 'continuous deployment', 'continuous delivery'], category: 'DevOps' },
  { canonical: 'Helm',          aliases: ['helm', 'helm charts'],                                category: 'DevOps' },
  { canonical: 'ArgoCD',        aliases: ['argocd', 'argo cd'],                                  category: 'DevOps' },
  { canonical: 'Nginx',         aliases: ['nginx', 'nginx web server'],                          category: 'DevOps' },
  { canonical: 'Apache',        aliases: ['apache', 'apache httpd', 'apache web server'],         category: 'DevOps' },
  { canonical: 'Linux',         aliases: ['linux', 'ubuntu', 'centos', 'debian', 'rhel', 'fedora'], category: 'DevOps' },

  // ── AI & Machine Learning ─────────────────────────────────────────────────
  { canonical: 'Machine Learning', aliases: ['machine learning', 'ml', 'supervised learning', 'unsupervised learning'], category: 'AI/ML' },
  { canonical: 'Deep Learning', aliases: ['deep learning', 'dl', 'neural networks', 'neural network'], category: 'AI/ML' },
  { canonical: 'TensorFlow',    aliases: ['tensorflow', 'tf', 'tensor flow'],                    category: 'AI/ML' },
  { canonical: 'PyTorch',       aliases: ['pytorch', 'torch'],                                   category: 'AI/ML' },
  { canonical: 'Scikit-learn',  aliases: ['scikit-learn', 'sklearn', 'scikit learn'],             category: 'AI/ML' },
  { canonical: 'Keras',         aliases: ['keras'],                                              category: 'AI/ML' },
  { canonical: 'NLP',           aliases: ['nlp', 'natural language processing', 'text mining', 'text analytics'], category: 'AI/ML' },
  { canonical: 'Computer Vision', aliases: ['computer vision', 'cv', 'image recognition', 'object detection'], category: 'AI/ML' },
  { canonical: 'OpenCV',        aliases: ['opencv', 'open cv'],                                  category: 'AI/ML' },
  { canonical: 'Hugging Face',  aliases: ['hugging face', 'huggingface', 'transformers'],         category: 'AI/ML' },
  { canonical: 'LangChain',     aliases: ['langchain', 'lang chain'],                            category: 'AI/ML' },
  { canonical: 'OpenAI API',    aliases: ['openai', 'gpt', 'chatgpt', 'gpt-4', 'openai api'],    category: 'AI/ML' },
  { canonical: 'MLOps',         aliases: ['mlops', 'ml ops'],                                   category: 'AI/ML' },
  { canonical: 'RAG',           aliases: ['rag', 'retrieval augmented generation', 'retrieval-augmented'], category: 'AI/ML' },
  { canonical: 'LLM',           aliases: ['llm', 'large language model', 'large language models'], category: 'AI/ML' },
  { canonical: 'Reinforcement Learning', aliases: ['reinforcement learning', 'rl', 'q-learning'], category: 'AI/ML' },

  // ── Data Science & Analytics ──────────────────────────────────────────────
  { canonical: 'Data Analysis', aliases: ['data analysis', 'data analytics', 'statistical analysis'], category: 'Data' },
  { canonical: 'Data Engineering', aliases: ['data engineering', 'data pipeline', 'etl'],        category: 'Data' },
  { canonical: 'Pandas',        aliases: ['pandas'],                                             category: 'Data' },
  { canonical: 'NumPy',         aliases: ['numpy', 'num py'],                                    category: 'Data' },
  { canonical: 'Jupyter',       aliases: ['jupyter', 'jupyter notebook', 'jupyter lab'],          category: 'Data' },
  { canonical: 'Apache Spark',  aliases: ['spark', 'apache spark', 'pyspark'],                   category: 'Data' },
  { canonical: 'Apache Hadoop', aliases: ['hadoop', 'apache hadoop', 'hdfs', 'mapreduce'],        category: 'Data' },
  { canonical: 'Airflow',       aliases: ['airflow', 'apache airflow'],                          category: 'Data' },
  { canonical: 'dbt',           aliases: ['dbt', 'data build tool'],                             category: 'Data' },
  { canonical: 'Snowflake',     aliases: ['snowflake'],                                          category: 'Data' },
  { canonical: 'BigQuery',      aliases: ['bigquery', 'big query', 'google bigquery'],            category: 'Data' },
  { canonical: 'Tableau',       aliases: ['tableau', 'tableau desktop', 'tableau server'],        category: 'Data' },
  { canonical: 'Power BI',      aliases: ['power bi', 'powerbi', 'microsoft power bi'],           category: 'Data' },
  { canonical: 'Looker',        aliases: ['looker', 'looker studio', 'google looker'],            category: 'Data' },
  { canonical: 'Databricks',    aliases: ['databricks'],                                         category: 'Data' },
  { canonical: 'Statistics',    aliases: ['statistics', 'statistical modelling', 'regression analysis', 'hypothesis testing'], category: 'Data' },
  { canonical: 'A/B Testing',   aliases: ['a/b testing', 'ab testing', 'split testing', 'experiment design'], category: 'Data' },
  { canonical: 'ETL',           aliases: ['etl', 'extract transform load', 'data transformation'], category: 'Data' },

  // ── Cybersecurity ─────────────────────────────────────────────────────────
  { canonical: 'Cybersecurity', aliases: ['cybersecurity', 'cyber security', 'information security', 'infosec'], category: 'Cybersecurity' },
  { canonical: 'Penetration Testing', aliases: ['penetration testing', 'pen testing', 'pentesting', 'ethical hacking'], category: 'Cybersecurity' },
  { canonical: 'Network Security', aliases: ['network security', 'firewall', 'vpn'],             category: 'Cybersecurity' },
  { canonical: 'SIEM',          aliases: ['siem', 'splunk', 'qradar'],                          category: 'Cybersecurity' },
  { canonical: 'Vulnerability Assessment', aliases: ['vulnerability assessment', 'vapt', 'vulnerability scanning'], category: 'Cybersecurity' },
  { canonical: 'OWASP',         aliases: ['owasp'],                                             category: 'Cybersecurity' },
  { canonical: 'Encryption',    aliases: ['encryption', 'cryptography', 'ssl', 'tls', 'https'], category: 'Cybersecurity' },
  { canonical: 'IAM',           aliases: ['iam', 'identity access management', 'oauth', 'saml', 'sso'], category: 'Cybersecurity' },
  { canonical: 'SOC',           aliases: ['soc', 'security operations center', 'incident response'], category: 'Cybersecurity' },
  { canonical: 'CompTIA',       aliases: ['comptia', 'security+', 'network+', 'cissp', 'ceh'],  category: 'Cybersecurity' },

  // ── Microsoft Office & Productivity ───────────────────────────────────────
  { canonical: 'Excel',         aliases: ['excel', 'ms excel', 'microsoft excel', 'excel vba', 'advanced excel'], category: 'Productivity' },
  { canonical: 'Word',          aliases: ['ms word', 'microsoft word', 'word'],                  category: 'Productivity' },
  { canonical: 'PowerPoint',    aliases: ['powerpoint', 'ms powerpoint', 'microsoft powerpoint'], category: 'Productivity' },
  { canonical: 'Outlook',       aliases: ['outlook', 'ms outlook'],                              category: 'Productivity' },
  { canonical: 'SharePoint',    aliases: ['sharepoint', 'share point'],                          category: 'Productivity' },
  { canonical: 'Microsoft 365', aliases: ['microsoft 365', 'office 365', 'm365', 'o365'],        category: 'Productivity' },
  { canonical: 'Google Workspace', aliases: ['google workspace', 'g suite', 'gsuite', 'google sheets', 'google docs'], category: 'Productivity' },
  { canonical: 'Notion',        aliases: ['notion'],                                             category: 'Productivity' },
  { canonical: 'Confluence',    aliases: ['confluence', 'atlassian confluence'],                 category: 'Productivity' },
  { canonical: 'Jira',          aliases: ['jira', 'atlassian jira'],                             category: 'Productivity' },
  { canonical: 'Slack',         aliases: ['slack'],                                              category: 'Productivity' },
  { canonical: 'Trello',        aliases: ['trello'],                                             category: 'Productivity' },
  { canonical: 'Asana',         aliases: ['asana'],                                              category: 'Productivity' },

  // ── Finance & Accounting ──────────────────────────────────────────────────
  { canonical: 'Tally',         aliases: ['tally', 'tally erp', 'tally erp 9', 'tally prime'], category: 'Finance' },
  { canonical: 'QuickBooks',    aliases: ['quickbooks', 'quick books', 'intuit quickbooks'],    category: 'Finance' },
  { canonical: 'SAP',           aliases: ['sap', 'sap fi', 'sap fico', 'sap erp', 'sap s4hana', 'sap s/4hana'], category: 'Finance' },
  { canonical: 'SAP FICO',      aliases: ['sap fico', 'sap fi/co', 'sap finance'],              category: 'Finance' },
  { canonical: 'GST',           aliases: ['gst', 'gst filing', 'gst return', 'gst compliance', 'goods and services tax'], category: 'Finance' },
  { canonical: 'TDS',           aliases: ['tds', 'tax deducted at source', 'tds filing'],       category: 'Finance' },
  { canonical: 'Income Tax',    aliases: ['income tax', 'itr', 'income tax return'],             category: 'Finance' },
  { canonical: 'Financial Reporting', aliases: ['financial reporting', 'financial statements', 'balance sheet', 'p&l'], category: 'Finance' },
  { canonical: 'Accounts Payable', aliases: ['accounts payable', 'ap', 'vendor payments'],      category: 'Finance' },
  { canonical: 'Accounts Receivable', aliases: ['accounts receivable', 'ar', 'collections'],    category: 'Finance' },
  { canonical: 'Payroll',       aliases: ['payroll', 'payroll processing', 'payroll management'], category: 'Finance' },
  { canonical: 'Auditing',      aliases: ['auditing', 'internal audit', 'statutory audit'],     category: 'Finance' },
  { canonical: 'Budgeting',     aliases: ['budgeting', 'budget planning', 'forecasting', 'financial planning'], category: 'Finance' },
  { canonical: 'Cost Accounting', aliases: ['cost accounting', 'cost analysis', 'cost control'], category: 'Finance' },
  { canonical: 'Taxation',      aliases: ['taxation', 'tax planning', 'tax compliance'],         category: 'Finance' },
  { canonical: 'IFRS',          aliases: ['ifrs', 'international financial reporting standards'], category: 'Finance' },
  { canonical: 'GAAP',          aliases: ['gaap', 'us gaap', 'generally accepted accounting'],  category: 'Finance' },
  { canonical: 'Zoho Books',    aliases: ['zoho books', 'zoho accounting'],                      category: 'Finance' },
  { canonical: 'Xero',          aliases: ['xero'],                                               category: 'Finance' },
  { canonical: 'FreshBooks',    aliases: ['freshbooks', 'fresh books'],                          category: 'Finance' },
  { canonical: 'Bloomberg',     aliases: ['bloomberg', 'bloomberg terminal'],                    category: 'Finance' },
  { canonical: 'Valuation',     aliases: ['valuation', 'business valuation', 'dcf', 'discounted cash flow'], category: 'Finance' },
  { canonical: 'Risk Management', aliases: ['risk management', 'risk assessment', 'credit risk', 'market risk'], category: 'Finance' },
  { canonical: 'Investment Banking', aliases: ['investment banking', 'ib', 'm&a', 'mergers and acquisitions'], category: 'Finance' },
  { canonical: 'Financial Modelling', aliases: ['financial modelling', 'financial modeling', 'financial model'], category: 'Finance' },
  { canonical: 'Treasury',      aliases: ['treasury', 'cash management', 'treasury operations'], category: 'Finance' },

  // ── ERP Systems ───────────────────────────────────────────────────────────
  { canonical: 'Oracle ERP',    aliases: ['oracle erp', 'oracle financials', 'oracle fusion', 'oracle cloud erp'], category: 'ERP' },
  { canonical: 'Microsoft Dynamics', aliases: ['microsoft dynamics', 'dynamics 365', 'dynamics ax', 'dynamics nav'], category: 'ERP' },
  { canonical: 'Workday',       aliases: ['workday'],                                            category: 'ERP' },
  { canonical: 'NetSuite',      aliases: ['netsuite', 'oracle netsuite'],                        category: 'ERP' },

  // ── Project Management ────────────────────────────────────────────────────
  { canonical: 'Agile',         aliases: ['agile', 'agile methodology'],                         category: 'Management' },
  { canonical: 'Scrum',         aliases: ['scrum', 'scrum master', 'sprint planning'],           category: 'Management' },
  { canonical: 'Kanban',        aliases: ['kanban'],                                             category: 'Management' },
  { canonical: 'PMP',           aliases: ['pmp', 'project management professional', 'prince2'],  category: 'Management' },
  { canonical: 'Waterfall',     aliases: ['waterfall', 'waterfall methodology'],                 category: 'Management' },
  { canonical: 'Product Management', aliases: ['product management', 'product roadmap', 'product strategy'], category: 'Management' },
  { canonical: 'Stakeholder Management', aliases: ['stakeholder management', 'stakeholder engagement'], category: 'Management' },
  { canonical: 'Risk Assessment', aliases: ['risk assessment'],                                  category: 'Management' },
  { canonical: 'Microsoft Project', aliases: ['microsoft project', 'ms project'],               category: 'Management' },
  { canonical: 'Monday.com',   aliases: ['monday.com', 'monday'],                               category: 'Management' },

  // ── Marketing & SEO ───────────────────────────────────────────────────────
  { canonical: 'Digital Marketing', aliases: ['digital marketing', 'online marketing', 'internet marketing'], category: 'Marketing' },
  { canonical: 'SEO',           aliases: ['seo', 'search engine optimization', 'search engine optimisation'], category: 'Marketing' },
  { canonical: 'SEM',           aliases: ['sem', 'search engine marketing', 'ppc', 'pay per click'], category: 'Marketing' },
  { canonical: 'Google Ads',    aliases: ['google ads', 'google adwords', 'adwords'],           category: 'Marketing' },
  { canonical: 'Meta Ads',      aliases: ['meta ads', 'facebook ads', 'instagram ads', 'facebook advertising'], category: 'Marketing' },
  { canonical: 'Content Marketing', aliases: ['content marketing', 'content strategy', 'content creation'], category: 'Marketing' },
  { canonical: 'Social Media Marketing', aliases: ['social media marketing', 'smm', 'social media management'], category: 'Marketing' },
  { canonical: 'Email Marketing', aliases: ['email marketing', 'mailchimp', 'klaviyo', 'hubspot email'], category: 'Marketing' },
  { canonical: 'HubSpot',       aliases: ['hubspot', 'hub spot'],                               category: 'Marketing' },
  { canonical: 'Salesforce',    aliases: ['salesforce', 'sfdc', 'crm salesforce'],              category: 'Marketing' },
  { canonical: 'Google Analytics', aliases: ['google analytics', 'ga4', 'universal analytics'], category: 'Marketing' },
  { canonical: 'CRM',           aliases: ['crm', 'customer relationship management'],            category: 'Marketing' },
  { canonical: 'Marketing Automation', aliases: ['marketing automation', 'marketo', 'pardot'],  category: 'Marketing' },
  { canonical: 'Copywriting',   aliases: ['copywriting', 'copy writing'],                        category: 'Marketing' },
  { canonical: 'Brand Management', aliases: ['brand management', 'branding'],                   category: 'Marketing' },
  { canonical: 'Affiliate Marketing', aliases: ['affiliate marketing', 'affiliate'],             category: 'Marketing' },

  // ── Design ────────────────────────────────────────────────────────────────
  { canonical: 'Photoshop',     aliases: ['photoshop', 'adobe photoshop', 'ps'],                category: 'Design' },
  { canonical: 'Illustrator',   aliases: ['illustrator', 'adobe illustrator', 'ai'],            category: 'Design' },
  { canonical: 'Figma',         aliases: ['figma'],                                              category: 'Design' },
  { canonical: 'Sketch',        aliases: ['sketch', 'sketch app'],                              category: 'Design' },
  { canonical: 'Adobe XD',      aliases: ['adobe xd', 'xd'],                                    category: 'Design' },
  { canonical: 'InDesign',      aliases: ['indesign', 'adobe indesign'],                         category: 'Design' },
  { canonical: 'After Effects', aliases: ['after effects', 'adobe after effects', 'ae'],        category: 'Design' },
  { canonical: 'Premiere Pro',  aliases: ['premiere pro', 'adobe premiere', 'premiere'],        category: 'Design' },
  { canonical: 'UI/UX Design',  aliases: ['ui/ux', 'ui ux', 'user interface', 'user experience', 'ux design', 'ui design'], category: 'Design' },
  { canonical: 'Wireframing',   aliases: ['wireframing', 'wireframes', 'prototyping'],           category: 'Design' },
  { canonical: 'Canva',         aliases: ['canva'],                                              category: 'Design' },
  { canonical: 'AutoCAD',       aliases: ['autocad', 'auto cad', 'cad'],                        category: 'Design' },
  { canonical: 'SolidWorks',    aliases: ['solidworks', 'solid works'],                         category: 'Design' },

  // ── Sales ─────────────────────────────────────────────────────────────────
  { canonical: 'Sales',         aliases: ['sales', 'b2b sales', 'b2c sales', 'enterprise sales'], category: 'Sales' },
  { canonical: 'Business Development', aliases: ['business development', 'bd', 'biz dev'],       category: 'Sales' },
  { canonical: 'Lead Generation', aliases: ['lead generation', 'lead gen', 'prospecting'],       category: 'Sales' },
  { canonical: 'Cold Calling',  aliases: ['cold calling', 'cold calls', 'outbound sales'],       category: 'Sales' },
  { canonical: 'Negotiation',   aliases: ['negotiation', 'negotiating'],                         category: 'Sales' },
  { canonical: 'Revenue Operations', aliases: ['revenue operations', 'revops'],                  category: 'Sales' },
  { canonical: 'Account Management', aliases: ['account management', 'key account management'],  category: 'Sales' },
  { canonical: 'Salesforce CRM', aliases: ['salesforce crm'],                                   category: 'Sales' },
  { canonical: 'Forecasting',   aliases: ['sales forecasting', 'revenue forecasting'],           category: 'Sales' },

  // ── HR ────────────────────────────────────────────────────────────────────
  { canonical: 'Recruitment',   aliases: ['recruitment', 'recruiting', 'talent acquisition', 'hiring'], category: 'HR' },
  { canonical: 'HR Management', aliases: ['hr management', 'human resources', 'hr'],             category: 'HR' },
  { canonical: 'Employee Relations', aliases: ['employee relations', 'employee engagement'],     category: 'HR' },
  { canonical: 'Performance Management', aliases: ['performance management', 'performance review', 'appraisal'], category: 'HR' },
  { canonical: 'Learning & Development', aliases: ['learning and development', 'l&d', 'training and development'], category: 'HR' },
  { canonical: 'Compensation & Benefits', aliases: ['compensation and benefits', 'c&b', 'total rewards'], category: 'HR' },
  { canonical: 'HRIS',          aliases: ['hris', 'hr information system', 'workday hris', 'bamboohr'], category: 'HR' },
  { canonical: 'Labour Law',    aliases: ['labour law', 'labor law', 'employment law', 'hr compliance'], category: 'HR' },
  { canonical: 'Onboarding',    aliases: ['onboarding', 'employee onboarding'],                  category: 'HR' },

  // ── Operations & Supply Chain ─────────────────────────────────────────────
  { canonical: 'Operations Management', aliases: ['operations management', 'ops', 'operations'], category: 'Operations' },
  { canonical: 'Supply Chain',  aliases: ['supply chain', 'supply chain management', 'scm'],    category: 'Operations' },
  { canonical: 'Logistics',     aliases: ['logistics', 'logistics management'],                  category: 'Operations' },
  { canonical: 'Procurement',   aliases: ['procurement', 'purchasing', 'vendor management'],     category: 'Operations' },
  { canonical: 'Inventory Management', aliases: ['inventory management', 'stock management', 'warehouse management'], category: 'Operations' },
  { canonical: 'Lean',          aliases: ['lean', 'lean manufacturing', 'lean six sigma'],        category: 'Operations' },
  { canonical: 'Six Sigma',     aliases: ['six sigma', 'six-sigma', 'dmaic'],                    category: 'Operations' },
  { canonical: 'Process Improvement', aliases: ['process improvement', 'process optimization', 'bpi'], category: 'Operations' },
  { canonical: 'Quality Assurance', aliases: ['quality assurance', 'qa', 'quality control', 'qc', 'iso 9001'], category: 'Operations' },

  // ── Healthcare ────────────────────────────────────────────────────────────
  { canonical: 'Clinical Research', aliases: ['clinical research', 'clinical trials', 'gcp'],   category: 'Healthcare' },
  { canonical: 'Pharmacovigilance', aliases: ['pharmacovigilance', 'drug safety'],              category: 'Healthcare' },
  { canonical: 'Medical Writing', aliases: ['medical writing', 'regulatory writing'],            category: 'Healthcare' },
  { canonical: 'EMR',           aliases: ['emr', 'ehr', 'electronic medical records', 'epic', 'cerner'], category: 'Healthcare' },
  { canonical: 'HIPAA',         aliases: ['hipaa'],                                             category: 'Healthcare' },
  { canonical: 'Healthcare Administration', aliases: ['healthcare administration', 'hospital administration'], category: 'Healthcare' },
  { canonical: 'Patient Care',  aliases: ['patient care', 'patient management'],                category: 'Healthcare' },
  { canonical: 'Medical Billing', aliases: ['medical billing', 'medical coding', 'icd-10', 'cpt codes'], category: 'Healthcare' },

  // ── Engineering ───────────────────────────────────────────────────────────
  { canonical: 'Mechanical Engineering', aliases: ['mechanical engineering', 'mechanical design'], category: 'Engineering' },
  { canonical: 'Civil Engineering', aliases: ['civil engineering', 'structural engineering'],   category: 'Engineering' },
  { canonical: 'Electrical Engineering', aliases: ['electrical engineering', 'power systems', 'plc', 'scada'], category: 'Engineering' },
  { canonical: 'Chemical Engineering', aliases: ['chemical engineering', 'process engineering'], category: 'Engineering' },
  { canonical: 'Embedded Systems', aliases: ['embedded systems', 'embedded c', 'firmware', 'rtos'], category: 'Engineering' },
  { canonical: 'IoT',           aliases: ['iot', 'internet of things', 'iot devices'],          category: 'Engineering' },
  { canonical: 'VLSI',          aliases: ['vlsi', 'vhdl', 'verilog', 'fpga'],                   category: 'Engineering' },
  { canonical: 'CAD/CAM',       aliases: ['cad/cam', 'cam', 'cnc'],                             category: 'Engineering' },
  { canonical: 'GIS',           aliases: ['gis', 'geographic information system', 'arcgis', 'qgis'], category: 'Engineering' },

  // ── Legal & Compliance ────────────────────────────────────────────────────
  { canonical: 'Contract Management', aliases: ['contract management', 'contract drafting', 'contract review'], category: 'Legal' },
  { canonical: 'Corporate Law', aliases: ['corporate law', 'company law', 'legal compliance'],   category: 'Legal' },
  { canonical: 'Intellectual Property', aliases: ['intellectual property', 'ip law', 'patents', 'trademarks', 'copyright'], category: 'Legal' },
  { canonical: 'GDPR',          aliases: ['gdpr', 'data privacy', 'data protection'],           category: 'Legal' },
  { canonical: 'Legal Research', aliases: ['legal research', 'legal drafting'],                 category: 'Legal' },
  { canonical: 'Compliance',    aliases: ['compliance', 'regulatory compliance', 'aml', 'kyc'],  category: 'Legal' },

  // ── Soft Skills ───────────────────────────────────────────────────────────
  { canonical: 'Leadership',    aliases: ['leadership', 'team leadership', 'people management'], category: 'Soft Skills' },
  { canonical: 'Communication', aliases: ['communication', 'verbal communication', 'written communication'], category: 'Soft Skills' },
  { canonical: 'Problem Solving', aliases: ['problem solving', 'problem-solving', 'analytical thinking'], category: 'Soft Skills' },
  { canonical: 'Critical Thinking', aliases: ['critical thinking', 'analytical skills'],        category: 'Soft Skills' },
  { canonical: 'Team Collaboration', aliases: ['team collaboration', 'teamwork', 'cross-functional'], category: 'Soft Skills' },
  { canonical: 'Presentation',  aliases: ['presentation', 'presentation skills', 'public speaking'], category: 'Soft Skills' },
  { canonical: 'Time Management', aliases: ['time management'],                                 category: 'Soft Skills' },
  { canonical: 'Mentoring',     aliases: ['mentoring', 'coaching', 'mentorship'],               category: 'Soft Skills' },
  { canonical: 'Client Management', aliases: ['client management', 'client relations', 'customer management'], category: 'Soft Skills' },

  // ── Blockchain & Web3 ─────────────────────────────────────────────────────
  { canonical: 'Blockchain',    aliases: ['blockchain', 'distributed ledger'],                  category: 'Blockchain' },
  { canonical: 'Solidity',      aliases: ['solidity'],                                          category: 'Blockchain' },
  { canonical: 'Web3',          aliases: ['web3', 'web 3', 'defi', 'nft'],                      category: 'Blockchain' },
  { canonical: 'Smart Contracts', aliases: ['smart contracts', 'smart contract'],               category: 'Blockchain' },
  { canonical: 'Ethereum',      aliases: ['ethereum', 'eth'],                                   category: 'Blockchain' },

  // ── Testing & QA ──────────────────────────────────────────────────────────
  { canonical: 'Manual Testing', aliases: ['manual testing', 'manual qa', 'functional testing'], category: 'Testing' },
  { canonical: 'Automation Testing', aliases: ['automation testing', 'test automation', 'selenium', 'playwright', 'cypress'], category: 'Testing' },
  { canonical: 'Selenium',      aliases: ['selenium', 'selenium webdriver'],                    category: 'Testing' },
  { canonical: 'Cypress',       aliases: ['cypress', 'cypress.io'],                             category: 'Testing' },
  { canonical: 'Jest',          aliases: ['jest', 'jest testing'],                              category: 'Testing' },
  { canonical: 'Postman',       aliases: ['postman'],                                           category: 'Testing' },
  { canonical: 'API Testing',   aliases: ['api testing', 'rest api testing'],                   category: 'Testing' },
  { canonical: 'Performance Testing', aliases: ['performance testing', 'load testing', 'jmeter', 'k6'], category: 'Testing' },
  { canonical: 'Test Planning', aliases: ['test planning', 'test cases', 'test strategy'],      category: 'Testing' },
];

// ── Build lookup maps for O(1) detection ──────────────────────────────────────

/**
 * aliasMap: lowercase alias → { canonical, category }
 * Used to detect any alias in resume text and return the canonical name.
 */
const aliasMap = new Map();

for (const entry of SKILL_ENTRIES) {
  // Register canonical itself (lowercased)
  aliasMap.set(entry.canonical.toLowerCase(), { canonical: entry.canonical, category: entry.category });
  // Register all aliases
  for (const alias of entry.aliases) {
    aliasMap.set(alias.toLowerCase(), { canonical: entry.canonical, category: entry.category });
  }
}

module.exports = { SKILL_ENTRIES, aliasMap };









