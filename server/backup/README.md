# Weekly database backup

`salamanders-db-backup` takes a logical backup of the builds API database, proves it restores, and keeps the
newest eight. It runs on the host that runs `server/docker-compose.yml`, not inside Docker.

A file named `salamanders_builds-weekly-<UTC stamp>.dump` therefore always means *dumped, listed, restored and
compared*:

1. `pg_dump -Fc` of the running database container, and `pg_restore -l` must read it back.
2. A throwaway container of the **same image** restores it. Every table's row count and content hash, and every
   table and sequence privilege, must match the live database.
3. Only then are the `.dump`, `.sha256` and `.fingerprint` published, and only then does retention run, so a
   failing week never shrinks the set of proven backups. A dump that fails its restore is kept as
   `*.dump.failed-drill` and is never counted as, or restored as, a good one.

The script refuses to write unless the backup drive is really mounted (so a missing drive cannot fill the system
disk) and takes a lock so two runs cannot overlap.

## Install

```sh
install -m 755 server/backup/salamanders-db-backup ~/.local/bin/
crontab -e   # add:
40 3 * * 0 $HOME/.local/bin/salamanders-db-backup >> $HOME/.local/state/salamanders-db-backup/cron.log 2>&1
```

That is Sundays at 03:40 local time. The user needs access to the Docker socket. The defaults are the production
values (`server-db-1`, `/mnt/bretpc/salamanders-db-backups`, keep 8); every setting is an environment variable,
documented in the header of the script, along with the exit codes.

**The latest result is always `~/.local/state/salamanders-db-backup/last-run`.** Nothing alerts on failure:
someone has to look at that file.

## Restore

Into a fresh volume, **create the app role first**, then restore. The dump's `GRANT`s name `salamanders_app`;
roles live in the cluster, not in the dump, so restoring first stops at the first `GRANT`.

```sh
{ printf '\\set app_password '"'"'%s'"'"'\n' "$APP_DB_PASSWORD"; cat server/app-role.sql; } \
  | docker compose exec -T db psql -U salamanders -d salamanders_builds -v ON_ERROR_STOP=1
docker compose exec -T db pg_restore -U salamanders -d salamanders_builds --exit-on-error < the.dump
```

Verify a dump without restoring it: `sha256sum -c the.sha256` in the backup directory.

## Tests

```sh
bash server/backup/test.sh           # ~200 cases against a fake `docker`; about 10 seconds
python3 -I server/backup/mutate.py   # applies ~40 hand-made bugs one at a time; every one must make test.sh fail (~5 minutes)
```

The tests assert on the resulting directory contents, exit codes and the status file, never on which commands ran.
`mutate.py` is the substitute for a mutation tool, which does not exist for shell: a surviving mutant is a hole in
the tests (or must be justified as an equivalent mutant), never to be ignored.

`test.sh` ends with a canary that fails if the **real** backup directory changed during the run
(`BACKUP_PROD_DIR`, default `/mnt/bretpc/salamanders-db-backups`). It exists because an earlier version fell back to
the production path when `DEST` was set but empty, and a test wrote fake files into the real backups. An empty
`DEST` is now rejected; do not weaken that check, and do not add a test or mutant that can reach the default `DEST`.

After editing the script, rerun both, then reinstall it (`install -m 755 ...` above); the installed copy is what
cron runs.
