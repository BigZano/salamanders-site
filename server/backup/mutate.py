"""Poor man's mutation testing for salamanders-db-backup: apply one bug at a time to a copy of the
script and require test.sh to FAIL. A mutant that passes is a hole in the tests (or an equivalent
mutant, which must be justified, never ignored).

Not mutated on purpose: DEST=${DEST-...} -> ${DEST:-...}. That bug falls back to the production
path, so running it would write into the real backup directory; the test for it (DEST empty) plus
the canary guard it, and it was caught for real once already.
"""
import os, subprocess, sys, tempfile, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "salamanders-db-backup")
TEST = os.path.join(HERE, "test.sh")
PROD = os.environ.get("BACKUP_PROD_DIR", "/mnt/bretpc/salamanders-db-backups")

src = open(SRC).read()
T = 'tail -n +"$((KEEP + 1))"'
MUTANTS = [
    ("retention off by one (deletes one extra)", T, 'tail -n +"$((KEEP))"'),
    ("retention off by one (keeps one extra)", T, 'tail -n +"$((KEEP + 2))"'),
    ("prune oldest-first reversed (deletes the newest)", "sort -r", "sort"),
    ("directories counted as dumps", '  [ -f "$f" ] || continue\n', ""),
    ("prune name regex loses ^", "[[ $base =~ ^salamanders_builds-weekly-", "[[ $base =~ salamanders_builds-weekly-"),
    ("prune name regex loses $", "\\.dump$ ]] || continue", "\\.dump ]] || continue"),
    ("KEEP accepts 0 and leading zeros", "^[1-9][0-9]{0,2}$", "^[0-9]{1,3}$"),
    ("KEEP accepts 4 digits", "^[1-9][0-9]{0,2}$", "^[1-9][0-9]{0,3}$"),
    ("DRILL accepts any digit", "^[01]$ ]]", "^[0-9]$ ]]"),
    ("mount check removed", 'mountpoint -q -- "$mount_real" || fail 3', "true || fail 3"),
    ("DEST containment check removed", '*) fail 2 "DEST ($DEST_REAL) is not inside', '*) true "DEST ($DEST_REAL) is not inside'),
    ("mount prefix not normalised", "mount_base=${mount_real%/}", "mount_base=${mount_real}"),
    ("DEST not resolved (.. and symlinks)", 'DEST_REAL=$(realpath -m -- "$DEST") ||', 'DEST_REAL=$(printf %s "$DEST") ||'),
    ("name validation removed", '[[ ${!v} =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] ||', "true ||"),
    ("stopped container tolerated", '[ "$running" = true ] || fail 4', "true || fail 4"),
    ("empty dump accepted", '[ -s "$PARTIAL" ] || fail 6 "the dump is empty"', "true"),
    ("empty TOC accepted", "grep -qE '^[^;[:space:]]' || fail 6 \"the dump has no table of contents entries\"", "true"),
    ("no-tables database accepted", '[ -n "$fp_before" ] || fail 6', "true || fail 6"),
    ("pg_dump failure uses the wrong code", 'fail 5 "pg_dump failed"', 'fail 6 "pg_dump failed"'),
    ("partial left behind on failure", "OWN_PARTIAL=1\n  docker exec", "OWN_PARTIAL=0\n  docker exec"),
    ("changing database never re-dumped", '[ "$fp_before" = "$fp_after" ] && break', "true && break"),
    ("retry bound 3 -> 2", '[ "$attempt" -lt 3 ]', '[ "$attempt" -lt 2 ]'),
    ("retry bound 3 -> 4", '[ "$attempt" -lt 3 ]', '[ "$attempt" -lt 4 ]'),
    ("restore drill compare always passes", '[ "$fp_drill" = "$fp_after" ] || drill_fail', "true || drill_fail"),
    ("drill forgets to create the app role", 'docker exec "$SCRATCH" psql -U "$DB_USER" -d "$DB_NAME" -X -w -q -c "create role', 'true docker exec "$SCRATCH" psql -U "$DB_USER" -d "$DB_NAME" -X -w -q -c "create role'),
    ("role-creation failure ignored", '|| drill_fail "could not create role $APP_ROLE in the drill container"', "|| true"),
    ("restore error text dropped", '< "$PARTIAL" 2>&1 > /dev/null)', '< "$PARTIAL" 2>/dev/null > /dev/null)'),
    ("privilege comparison always passes", '[ "$acl_live" = "$acl_drill" ] || drill_fail', 'true || drill_fail'),
    ("APP_ROLE not validated", "[[ -z $APP_ROLE || $APP_ROLE =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] ||", "true ||"),
    ("failed drill not quarantined", 'mv -f -- "$PARTIAL" "$FINAL.failed-drill" 2>/dev/null && OWN_PARTIAL=0', "true"),
    ("drill never runs", 'if [ "$DRILL" = 1 ]; then\n  SCRATCH', "if false; then\n  SCRATCH"),
    ("drill always runs", 'if [ "$DRILL" = 1 ]; then\n  SCRATCH', "if true; then\n  SCRATCH"),
    ("no run lock", "flock -n 9 ||", "true ||"),
    ("losing run clobbers the status file", "NO_STATUS=1; echo \"another", "echo \"another"),
    ("checksum sidecar not pruned", ' "$DEST_REAL/${old%.dump}.sha256"', ""),
    ("fingerprint sidecar not pruned", ' "$DEST_REAL/${old%.dump}.fingerprint"', ""),
    ("fingerprint sidecar not written", 'printf \'%s\\n\' "$fp_after" > "$DEST_REAL/$NAME.fingerprint" || fail 5 "could not write the fingerprint"', "true"),
    ("checksum sidecar not written", 'printf \'%s  %s\\n\' "$sha" "$NAME.dump" > "$DEST_REAL/$NAME.sha256" || fail 5 "could not write the checksum"', "true"),
    ("dump left under the .partial name", 'mv -- "$PARTIAL" "$FINAL" || fail 5', 'cp -- "$PARTIAL" "$FINAL" || fail 5'),
    ("dumps world-readable", "umask 077\nPATH", "umask 022\nPATH"),
    ("backup dir world-readable", 'mkdir -p -m 700 -- "$DEST_REAL"', 'mkdir -p -m 755 -- "$DEST_REAL"'),
]

def prod_state():
    try:
        return sorted((f, os.stat(os.path.join(PROD, f)).st_size) for f in os.listdir(PROD))
    except FileNotFoundError:
        return None

work = tempfile.mkdtemp(prefix="dbmut.")
survivors, killed, bad = [], 0, []
before = prod_state()
try:
    only = sys.argv[1:]   # optional: substrings of mutant descriptions to run (a quick re-check)
    for i, (desc, old, new) in enumerate(MUTANTS, 1):
        if only and not any(o in desc for o in only):
            continue
        n = src.count(old)
        if n != 1:
            bad.append((desc, f"pattern found {n} times (need exactly 1)"))
            continue
        path = os.path.join(work, f"m{i}")
        open(path, "w").write(src.replace(old, new))
        os.chmod(path, 0o755)
        r = subprocess.run(["bash", TEST], env={**os.environ, "SCRIPT": path},
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=300)
        if prod_state() != before:
            print(f"ABORT: mutant {i} ({desc}) touched the production backup directory"); sys.exit(3)
        if r.returncode == 0:
            survivors.append(desc); print(f"SURVIVED  {i:2d}  {desc}")
        else:
            killed += 1
            failing = sorted({l.split("]")[0].lstrip("FAIL [") for l in r.stdout.splitlines() if l.startswith("FAIL [")})
            print(f"killed    {i:2d}  {desc}   <- {', '.join(failing[:3])}{'…' if len(failing) > 3 else ''}")
finally:
    shutil.rmtree(work, ignore_errors=True)

print(f"\nmutants: {len(MUTANTS)}  killed: {killed}  survived: {len(survivors)}  unusable patterns: {len(bad)}")
for d, why in bad: print("UNUSABLE", d, "-", why)
sys.exit(1 if survivors or bad else 0)
