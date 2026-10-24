#!/usr/bin/env bash
# Adversarial tests for salamanders-db-backup. A fake `docker` lets every failure mode be forced;
# every assertion is on the resulting directory contents, exit code or status file, never on
# which commands ran. SCRIPT=<path> tests a mutated copy (see mutate.sh).
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPT=${SCRIPT:-$HERE/salamanders-db-backup}
ROOT=$(mktemp -d /tmp/dbbackup-test.XXXXXX)
trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0; CASE=""

BIN=$ROOT/bin; mkdir -p "$BIN"
cat > "$BIN/docker" <<'SHIM'
#!/usr/bin/env bash
FP_DEFAULT=$'builds|13|aaaa\nreports|1|bbbb'
case "$1" in
  inspect)
    shift
    [ "${FAKE_NO_CONTAINER:-}" = 1 ] && { echo "Error: No such object" >&2; exit 1; }
    fmt=""; while [ $# -gt 0 ]; do case $1 in -f|--format) fmt=$2; shift 2 ;; *) shift ;; esac; done
    case "$fmt" in
      *State.Running*) echo "${FAKE_RUNNING:-true}" ;;
      *Config.Image*)  echo "fake/postgres:16" ;;
    esac
    exit 0 ;;
  run) [ "${FAKE_RUN_FAIL:-}" = 1 ] && exit 1; echo fakeid; exit 0 ;;
  rm)  exit 0 ;;
  exec)
    shift; [ "$1" = "-i" ] && shift
    c=$1; shift; cmd=$1; shift
    case "$cmd" in
      pg_dump)
        [ "${FAKE_DUMP_FAIL:-}" = 1 ] && { echo "pg_dump: error: boom" >&2; exit 1; }
        case "${FAKE_DUMP_MODE:-good}" in
          good) printf 'PGDMP\001%s' "${FAKE_DUMP_BODY:-body}" ;;
          empty) : ;;
          garbage) printf 'this is not a postgres archive' ;;
        esac
        exit 0 ;;
      pg_restore)
        if [ "$1" = "-l" ]; then
          [ "$(head -c5)" = "PGDMP" ] || { echo "pg_restore: error: not a valid archive" >&2; exit 1; }
          [ "${FAKE_TOC_EMPTY:-}" = 1 ] && exit 0
          printf ';\n; Archive created at fake\n;\n1; 0 0 TABLE public builds salamanders\n2; 0 0 TABLE public reports salamanders\n'
          exit 0
        fi
        cat > /dev/null
        [ "${FAKE_RESTORE_FAIL:-}" = 1 ] && { echo "pg_restore: error: simulated failure" >&2; exit 1; }
        if [ "${FAKE_DUMP_HAS_ACLS:-1}" = 1 ] && [ ! -e "$FAKE_STATE/role-$c" ]; then
          echo 'pg_restore: error: could not execute query: ERROR:  role "salamanders_app" does not exist' >&2; exit 1
        fi
        exit 0 ;;
      pg_isready) [ "${FAKE_NEVER_READY:-}" = 1 ] && exit 2; exit 0 ;;
      psql)
        sql="${!#}"
        case "$sql" in
          *"create role"*) [ "${FAKE_ROLE_FAIL:-}" = 1 ] && exit 1; touch "$FAKE_STATE/role-$c"; exit 0 ;;
          *relacl*)
            if [ -n "${FAKE_ACL_MISMATCH:-}" ] && [[ "$c" == bkpdrill-* ]]; then printf 'builds|{}\n'; else printf 'builds|{salamanders=arwd/salamanders,salamanders_app=arwd/salamanders}\n'; fi
            exit 0 ;;
        esac
        case "$c" in
          bkpdrill-*)
            if [ -n "${FAKE_DRILL_MISMATCH:-}" ]; then printf 'builds|12|zzzz\n'; else printf '%s\n' "$FP_DEFAULT"; fi ;;
          *)
            [ "${FAKE_FP_EMPTY:-}" = 1 ] && exit 0
            n=$(( $(cat "$FAKE_STATE/n" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$FAKE_STATE/n"
            if [ -n "${FAKE_FP_UNSTABLE_CALLS:-}" ] && [ "$n" -le "$FAKE_FP_UNSTABLE_CALLS" ]; then
              printf 'builds|%s|x\n' "$n"
            else
              printf '%s\n' "$FP_DEFAULT"
            fi ;;
        esac
        exit 0 ;;
    esac ;;
esac
exit 0
SHIM
chmod +x "$BIN/docker"
export PATH="$BIN:$PATH"

# Canary: the production backup directory must be byte-for-byte the same after the run.
PROD=${BACKUP_PROD_DIR:-/mnt/bretpc/salamanders-db-backups}
canary() { ls -lA --time-style=+%s "$PROD" 2>/dev/null | grep -v '^total'; }
CANARY_BEFORE=$(canary)

FPFILE_DEFAULT=$'builds|13|aaaa\nreports|1|bbbb'
NEWSTAMP=20261101T030000Z

new_case() {
  CASE=$1
  D=$ROOT/c$RANDOM$RANDOM; mkdir -p "$D/dest" "$D/state" "$D/fake"
  export DEST="$D/dest" STATE_DIR="$D/state" FAKE_STATE="$D/fake" REQUIRE_MOUNT= KEEP=8 DRILL=1
  export BACKUP_STAMP=$NEWSTAMP DRILL_READY_TRIES=2 DRILL_READY_DELAY=0.01
  unset CONTAINER DB_USER DB_NAME
  unset FAKE_RUNNING FAKE_NO_CONTAINER FAKE_DUMP_FAIL FAKE_DUMP_MODE FAKE_DUMP_BODY FAKE_TOC_EMPTY \
        FAKE_FP_UNSTABLE_CALLS FAKE_FP_EMPTY FAKE_RESTORE_FAIL FAKE_DRILL_MISMATCH FAKE_NEVER_READY FAKE_RUN_FAIL FAKE_ROLE_FAIL FAKE_ACL_MISMATCH FAKE_DUMP_HAS_ACLS APP_ROLE
}
run() { RC=0; OUT=$("$SCRIPT" 2>&1 < /dev/null) || RC=$?; }
t() { local desc=$1; shift; if "$@"; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); echo "FAIL [$CASE] $desc"; fi; }
rc_is()     { [ "$RC" = "$1" ]; }
names()     { ls -1A "$DEST" 2>/dev/null | LC_ALL=C sort; }
names_are() { [ "$(names)" = "$(printf '%s\n' "$@" | LC_ALL=C sort)" ]; }
same_as()   { [ "$(names)" = "$1" ]; }
status_has(){ grep -q -- "$1" "$STATE_DIR/last-run" 2>/dev/null; }
no_partials(){ ! ls "$DEST" 2>/dev/null | grep -q 'partial'; }
W() { echo "salamanders_builds-weekly-$1"; }
mkweekly() { printf 'old-%s' "$1" > "$DEST/$(W "$1").dump"; echo sha > "$DEST/$(W "$1").sha256"; echo fp > "$DEST/$(W "$1").fingerprint"; }
mkweeklies() { local d; for d in "$@"; do mkweekly "202610${d}T030000Z"; done; }
sidecars() { echo "$(W "$1").dump" "$(W "$1").sha256" "$(W "$1").fingerprint"; }

# ---------------------------------------------------------------------------------------------
new_case happy; DEST="$D/fresh/backups"; export DEST
FAKE_DUMP_BODY=hello; export FAKE_DUMP_BODY
run
t "exit 0" rc_is 0
t "exactly dump + two sidecars" names_are "$(W $NEWSTAMP).dump" "$(W $NEWSTAMP).sha256" "$(W $NEWSTAMP).fingerprint"
t "dump holds what pg_dump emitted" [ "$(cat "$DEST/$(W $NEWSTAMP).dump")" = $'PGDMP\001hello' ]
t "sha256 sidecar verifies the dump" bash -c "cd '$DEST' && sha256sum -c --quiet '$(W $NEWSTAMP).sha256'"
t "fingerprint sidecar is the table fingerprint" [ "$(cat "$DEST/$(W $NEWSTAMP).fingerprint")" = "$FPFILE_DEFAULT" ]
t "dump is private (600)" [ "$(stat -c %a "$DEST/$(W $NEWSTAMP).dump")" = 600 ]
t "backup dir is private (700)" [ "$(stat -c %a "$DEST")" = 700 ]
t "status says OK + drilled" bash -c "grep -q ' OK ' '$STATE_DIR/last-run' && grep -q 'drilled=yes' '$STATE_DIR/last-run'"

# ---- retention -----------------------------------------------------------------------------
new_case retention; mkweeklies 01 02 03 04 05 06 07 08 09 10 11 12
DECOYS=("salamanders_builds-pre-pg16.15-20261024T164921Z.dump" "$(W 20261101T030000Z).dump.bak" "x$(W 20260901T030000Z).dump"
        "salamanders_builds-weekly-2026.dump" "$(W 20260902T030000Z).dump.failed-drill" "random notes.txt" "$(W 20260903T030000Z).dump.partial"
        "salamanders_builds-weekly-junk-$(W 20260904T030000Z).dump" "$(W 20260905T030000Z).dump.dump" "$(W 20260906T030000Z).DUMP")
for f in "${DECOYS[@]}"; do echo keep > "$DEST/$f"; done
run
EXPECT=("${DECOYS[@]}" $(sidecars $NEWSTAMP)); for d in 12 11 10 09 08 07 06; do EXPECT+=($(sidecars "202610${d}T030000Z")); done
t "exit 0" rc_is 0
t "newest 8 kept (with sidecars), 5 oldest gone with theirs, decoys untouched" names_are "${EXPECT[@]}"

new_case keep-boundary-exact; mkweeklies 01 02 03 04 05 06 07; run   # 7 old + new = 8 = KEEP
t "8 of 8 -> nothing deleted" bash -c "[ \$(ls '$DEST'/*.dump | wc -l) = 8 ] && [ -f '$DEST/$(W 20261001T030000Z).dump' ]"
new_case keep-boundary-plus-one; mkweeklies 01 02 03 04 05 06 07 08; run  # 8 old + new = 9 -> drop exactly the oldest
t "9 of 8 -> exactly the oldest deleted" bash -c "[ \$(ls '$DEST'/*.dump | wc -l) = 8 ] && [ ! -e '$DEST/$(W 20261001T030000Z).dump' ] && [ ! -e '$DEST/$(W 20261001T030000Z).sha256' ] && [ -f '$DEST/$(W 20261002T030000Z).dump' ]"
new_case keep-one; KEEP=1; export KEEP; mkweeklies 01 02 03; run
t "KEEP=1 leaves only the new dump" names_are $(sidecars $NEWSTAMP)

new_case retention-dir-and-symlink; KEEP=2; export KEEP
mkweekly 20261020T030000Z; mkweekly 20261010T030000Z
mkdir "$DEST/$(W 20261030T030000Z).dump"                       # a DIRECTORY with a dump-like name
echo outside > "$D/outside.txt"; ln -s "$D/outside.txt" "$DEST/$(W 20261001T030000Z).dump"   # oldest, a symlink
run
t "directory is neither counted nor deleted" [ -d "$DEST/$(W 20261030T030000Z).dump" ]
t "newest regular old file survives (dir not counted toward KEEP)" [ -f "$DEST/$(W 20261020T030000Z).dump" ]
t "oldest regular file pruned" [ ! -e "$DEST/$(W 20261010T030000Z).dump" ]
t "symlink pruned but its target is not followed" bash -c "[ ! -L '$DEST/$(W 20261001T030000Z).dump' ] && [ -f '$D/outside.txt' ]"

# ---- configuration is rejected at the boundary, before anything is touched -------------------
for bad in "" 0 -1 abc 1.5 08 " 2" "2 " $'2\n' 1e3 0x10 1000 99999999999999999999 "2;touch pwned" '$(true)'; do
  new_case "KEEP=[$bad]"; mkweeklies 01 02 03; BEFORE=$(names); KEEP=$bad; export KEEP; run
  t "rc 2" rc_is 2
  t "directory untouched" same_as "$BEFORE"
  t "status FAILED exit=2" status_has "FAILED exit=2"
done
for bad in "" 2 yes 01; do
  new_case "DRILL=[$bad]"; mkweeklies 01; BEFORE=$(names); DRILL=$bad; export DRILL; run
  t "rc 2" rc_is 2; t "directory untouched" same_as "$BEFORE"
done
for bad in x 20261101 "20261101T030000Z/../../x" "20261101T030000" "20261101T030000Zjunk"; do
  new_case "BACKUP_STAMP=[$bad]"; mkweeklies 01; BEFORE=$(names); BACKUP_STAMP=$bad; export BACKUP_STAMP; run
  t "rc 2" rc_is 2; t "directory untouched" same_as "$BEFORE"
done
new_case "BACKUP_STAMP empty = not set"; BACKUP_STAMP=; export BACKUP_STAMP; run
t "an empty stamp means 'use the clock' (rc 0, a dated dump appears)" bash -c "[ '$RC' = 0 ] && ls '$DEST' | grep -qE '^salamanders_builds-weekly-[0-9]{8}T[0-9]{6}Z\.dump\$'"
new_case "DEST empty"; mkweeklies 01; BEFORE=$(names); REALDEST=$DEST; DEST=; export DEST; run; DEST=$REALDEST
t "rc 2 (never falls back to the production path)" rc_is 2; t "directory untouched" same_as "$BEFORE"
for v in CONTAINER DB_USER DB_NAME; do
  for bad in "" -rf "a b" "x;y" '$(id)' ".hidden" "-"; do
    new_case "$v=[$bad]"; mkweeklies 01; BEFORE=$(names); export "$v=$bad"; run
    t "rc 2" rc_is 2; t "directory untouched" same_as "$BEFORE"
  done
done

# ---- the backup drive must really be mounted ---------------------------------------------------
new_case "mount missing"; mkdir -p "$D/notmount"; REQUIRE_MOUNT="$D/notmount"; DEST="$D/notmount/backups"; export REQUIRE_MOUNT DEST; run
t "rc 3" rc_is 3
t "nothing created under the empty mountpoint" [ ! -e "$D/notmount/backups" ]
t "status FAILED exit=3" status_has "FAILED exit=3"
new_case "mount present"; REQUIRE_MOUNT=/; DEST="$D/anywhere"; export REQUIRE_MOUNT DEST; run
t "a real mountpoint (/) is accepted" rc_is 0
new_case "dest outside mount"; REQUIRE_MOUNT=/proc; DEST="$D/elsewhere"; export REQUIRE_MOUNT DEST; run
t "rc 2 (DEST not inside the mount)" rc_is 2; t "nothing created" [ ! -e "$D/elsewhere" ]
new_case "sibling prefix"; mkdir -p "$D/mnt"; REQUIRE_MOUNT="$D/mnt"; DEST="$D/mnt-evil/backups"; export REQUIRE_MOUNT DEST; run
t "rc 2 (/x/mnt-evil is not inside /x/mnt)" rc_is 2; t "nothing created" [ ! -e "$D/mnt-evil" ]
new_case "dotdot escape"; REQUIRE_MOUNT=/proc; DEST="/proc/../$D/escaped"; export REQUIRE_MOUNT DEST; run
t "rc 2 (.. resolved before the check)" rc_is 2
new_case "symlink escape"; mkdir -p "$D/mnt" "$D/real"; ln -s "$D/real" "$D/mnt/link"; REQUIRE_MOUNT="$D/mnt"; DEST="$D/mnt/link"; export REQUIRE_MOUNT DEST; run
t "rc 2 (symlink leaves the mount)" rc_is 2; t "nothing written through the link" [ -z "$(ls -A "$D/real")" ]

# ---- hostile paths -------------------------------------------------------------------------------
new_case "spaces and unicode in DEST"; DEST="$D/my dest/ünï cödé"; export DEST; run
t "rc 0" rc_is 0; t "dump written" [ -f "$DEST/$(W $NEWSTAMP).dump" ]

# ---- environment failures leave everything alone ---------------------------------------------------
new_case "container stopped"; mkweeklies 01 02 03; BEFORE=$(names); FAKE_RUNNING=false; export FAKE_RUNNING; run
t "rc 4" rc_is 4; t "untouched" same_as "$BEFORE"; t "status FAILED exit=4" status_has "FAILED exit=4"
new_case "container missing"; mkweeklies 01 02 03; BEFORE=$(names); FAKE_NO_CONTAINER=1; export FAKE_NO_CONTAINER; run
t "rc 4" rc_is 4; t "untouched" same_as "$BEFORE"

# ---- a bad dump never reaches the name that means "proven", and never triggers pruning ----------------
fail_case() { # name  expected-rc  ENV=VAL...
  new_case "$1"; local want=$2; shift 2; KEEP=3; export KEEP; mkweeklies 01 02 03 04 05; BEFORE=$(names)
  local kv; for kv in "$@"; do export "$kv"; done; run
  t "rc $want" rc_is "$want"; t "no prune, nothing published, no partials" same_as "$BEFORE"; t "status FAILED exit=$want" status_has "FAILED exit=$want"
}
fail_case "pg_dump fails"          5 FAKE_DUMP_FAIL=1
fail_case "empty dump"             6 FAKE_DUMP_MODE=empty
fail_case "garbage dump"           6 FAKE_DUMP_MODE=garbage
new_case "empty dump says so"; FAKE_DUMP_MODE=empty; export FAKE_DUMP_MODE; run
t "the status reason names the empty dump (what you read at 3am)" status_has "the dump is empty"
new_case "garbage dump says so"; FAKE_DUMP_MODE=garbage; export FAKE_DUMP_MODE; run
t "the status reason says pg_restore cannot read it" status_has "pg_restore cannot read the dump"
fail_case "empty table of contents" 6 FAKE_TOC_EMPTY=1
fail_case "database has no tables" 6 FAKE_FP_EMPTY=1
fail_case "database keeps changing" 7 FAKE_FP_UNSTABLE_CALLS=5   # calls 1-5 all differ -> 3 attempts exhausted
new_case "retry succeeds on the 3rd attempt"; FAKE_FP_UNSTABLE_CALLS=4; export FAKE_FP_UNSTABLE_CALLS; run
t "exactly 3 attempts are allowed (rc 0)" rc_is 0; t "published" [ -f "$DEST/$(W $NEWSTAMP).dump" ]; t "no partials" no_partials

# ---- the restore drill is the proof ---------------------------------------------------------------------
drill_case() {
  new_case "$1"; KEEP=3; export KEEP; mkweeklies 01 02 03 04 05; BEFORE=$(names); local kv; for kv in "${@:2}"; do export "$kv"; done; run
  t "rc 8" rc_is 8
  t "kept only as .failed-drill; old set intact; not pruned" bash -c "[ \"\$(ls -1A '$DEST' | grep -v failed-drill | LC_ALL=C sort)\" = \"$BEFORE\" ] && [ -f '$DEST/$(W $NEWSTAMP).dump.failed-drill' ]"
  t "no .dump or sidecars under the proven name" bash -c "[ ! -e '$DEST/$(W $NEWSTAMP).dump' ] && [ ! -e '$DEST/$(W $NEWSTAMP).sha256' ] && [ ! -e '$DEST/$(W $NEWSTAMP).fingerprint' ]"
  t "status FAILED exit=8" status_has "FAILED exit=8"
}
drill_case "restore fails"        FAKE_RESTORE_FAIL=1
drill_case "restored data differs" FAKE_DRILL_MISMATCH=1
drill_case "drill never ready"    FAKE_NEVER_READY=1
drill_case "drill container will not start" FAKE_RUN_FAIL=1
drill_case "app role cannot be created in the drill" FAKE_ROLE_FAIL=1
t "the reason says the role could not be created (not a vague restore failure)" status_has "could not create role"
drill_case "restored privileges differ" FAKE_ACL_MISMATCH=1
new_case "restore error is reported"; FAKE_RESTORE_FAIL=1; export FAKE_RESTORE_FAIL; run
t "the status reason carries pg_restore's own error" status_has "simulated failure"
new_case "role order matters"; APP_ROLE=; FAKE_DUMP_HAS_ACLS=0; FAKE_ROLE_FAIL=1; export APP_ROLE FAKE_DUMP_HAS_ACLS FAKE_ROLE_FAIL; run
t "APP_ROLE empty skips role creation (rc 0 even if it would fail)" rc_is 0
new_case "role missing from drill"; APP_ROLE=; export APP_ROLE; run
t "a dump with GRANTs cannot restore without the role (the real failure of 2026-10-24)" rc_is 8
for bad in "a b" "x;y" "-r" "1abc" '$(id)'; do
  new_case "APP_ROLE=[$bad]"; mkweeklies 01; BEFORE=$(names); export "APP_ROLE=$bad"; run
  t "rc 2" rc_is 2; t "directory untouched" same_as "$BEFORE"
done
new_case "drill skipped"; DRILL=0; FAKE_RESTORE_FAIL=1; FAKE_DRILL_MISMATCH=1; export DRILL FAKE_RESTORE_FAIL FAKE_DRILL_MISMATCH; run
t "DRILL=0 never restores (rc 0 despite a broken restore)" rc_is 0; t "published" [ -f "$DEST/$(W $NEWSTAMP).dump" ]; t "status says drilled=no" status_has "drilled=no"

# ---- one run at a time ------------------------------------------------------------------------------------
new_case "lock"; mkweeklies 01; BEFORE=$(names); echo "PREVIOUS" > "$STATE_DIR/last-run"
( exec 9> "$STATE_DIR/lock"; flock 9; sleep 2 ) & HOLDER=$!; sleep 0.4
run; wait "$HOLDER"
t "rc 9 while another run holds the lock" rc_is 9; t "untouched" same_as "$BEFORE"; t "status not clobbered" [ "$(cat "$STATE_DIR/last-run")" = PREVIOUS ]
run
t "runs again once the lock is free" rc_is 0

CASE=canary
t "the production backup directory was not touched by any test" [ "$(canary)" = "$CANARY_BEFORE" ]
echo "----"; echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" -eq 0 ]
