# Database Standards

## Migrations

-   Never rewrite applied production migrations.
-   One logical change per migration.
-   Prefer idempotent SQL.

## Security

-   Enable RLS where required.
-   Use SECURITY DEFINER only when justified.
-   Review grants and policies.

## Performance

-   Add indexes with justification.
-   Validate query plans for major changes.
