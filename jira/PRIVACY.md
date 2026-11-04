# Judge for Jira: Privacy

Judge for Jira is a Forge app that runs entirely on Atlassian's cloud.

**What it stores**, in the app's Forge storage on your site: the acceptance checks frozen on a work item, their SHA-256 hash and the time they were frozen, and the latest receipt (which checks passed or failed, a short detail for each, and SHA-256 hashes of the checks and of the delivery). It stores no account IDs, names or email addresses.

**What it reads**: comments and attachments on work items where checks are frozen, only to run the checks. Comments limited to a role or group are never judged.

**What it posts**: comments on the work item (the frozen checks and each pass or fail receipt).

**What leaves Atlassian**: nothing. No outside servers, no analytics or tracking, no outside AI service. The Judge agent runs inside Atlassian Rovo.

Uninstalling stops all processing; stored data is then handled under Atlassian's Forge data retention rules.

Contact: balasavijaytheking@gmail.com
