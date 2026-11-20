# n8n-to-claude

Renamed to [`n8n-migrate`](https://www.npmjs.com/package/n8n-migrate). The `n8n-to-claude` command runs `n8n-migrate` with the same arguments and exit codes.

```sh
npx n8n-migrate
```

Settings did not keep their old names: environment variables are `N8M_*` (were `N2C_*`), a converted folder keeps its state in `.n8m/` (was `.n2c/`), and saved sign-in clients are in `~/.config/n8n-migrate/`.

Docs, issues and source: [github.com/lunox-work/n8n-migrate](https://github.com/lunox-work/n8n-migrate).
