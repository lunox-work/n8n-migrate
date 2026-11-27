# n8n-migrate

Renamed to [`n8n-to-claude`](https://www.npmjs.com/package/n8n-to-claude). The `n8n-migrate` command runs `n8n-to-claude` with the same arguments and exit codes.

```sh
npx n8n-to-claude
```

Settings keep their names: environment variables are still `N8M_*` and a converted folder keeps its state in `.n8m/`. Saved sign-in clients move to `~/.config/n8n-to-claude/`, so n8n asks you to sign in once more.

Docs, issues and source: [github.com/lunox-work/n8n-to-claude](https://github.com/lunox-work/n8n-to-claude).
