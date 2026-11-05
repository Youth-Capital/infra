"""Back up/restore only YouthCapital, using its unprivileged database role."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import sys
import tarfile
from datetime import datetime, timezone

DATABASE = "yoshlar_kapitali_db"
ROLE = "yoshlar_kapitali_user"
CONTAINER = "infrastructure-postgres-postgres-1"


def settings(root):
    values = dict(line.split("=", 1) for line in
                  (root / "runtime/backend.env").read_text().splitlines() if line)
    if values.get("DB_NAME") != DATABASE or values.get("DB_USER") != ROLE:
        raise ValueError("Refusing access outside the verified YouthCapital database/role")
    return values


def database_command(values, restore=False):
    # `docker exec -e NAME` forwards the host process environment without putting
    # the secret in argv. TCP forces password auth as the app role, not postgres.
    command = ["docker", "exec", "-i", "-e", "PGPASSWORD", CONTAINER]
    command += ["pg_restore" if restore else "pg_dump", "--host=" + values["DB_HOST"],
                "--port=" + values["DB_PORT"], "--username=" + ROLE, "--dbname=" + DATABASE,
                "--no-password"]
    command += (["--clean", "--if-exists", "--no-owner", "--no-privileges",
                 "--single-transaction", "--exit-on-error"] if restore else ["--format=custom"])
    return command


def run_database(values, stream, restore=False):
    environment = {**os.environ, "PGPASSWORD": values["POSTGRES_PASSWORD"]}
    # Suppress libpq errors: connection errors can otherwise include user data.
    result = subprocess.run(database_command(values, restore), env=environment,
                            stdin=stream if restore else subprocess.DEVNULL,
                            stdout=subprocess.DEVNULL if restore else stream,
                            stderr=subprocess.DEVNULL, timeout=1500, check=False)
    if result.returncode:
        raise RuntimeError(f"Project database {'restore' if restore else 'dump'} failed")


def digest(file):
    with file.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def safe_member(member):
    name = PurePosixPath(member.name)
    if (not name.parts or name.is_absolute() or ".." in name.parts
            or name.parts[0] not in {"media", "private-media"}
            or ".tmp" in name.parts or "\\" in member.name
            or not (member.isfile() or member.isdir())):
        raise ValueError("Media archive contains an unsafe path or non-regular file")
    return member


def backup(root, values):
    parent = root / "backups"
    parent.mkdir(mode=0o700, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    work = parent / (".incomplete-" + stamp)
    work.mkdir(mode=0o700)
    with (work / "database.dump").open("xb") as stream:
        run_database(values, stream)
    if not (work / "database.dump").stat().st_size:
        raise ValueError("Project database dump is empty")

    def include(member):
        if ".tmp" in PurePosixPath(member.name).parts:
            return None
        return safe_member(member)

    with tarfile.open(work / "media.tar.gz", "w:gz") as archive:
        for name in ("media", "private-media"):
            archive.add(root / "data" / name, arcname=name, filter=include)
    manifest = {"project": "youthcapital", "database": DATABASE,
                "files": {name: digest(work / name) for name in ("database.dump", "media.tar.gz")}}
    (work / "manifest.json").write_text(json.dumps(manifest) + "\n")
    final = parent / stamp
    work.rename(final)
    print(f"Project backup complete: {final}")


def restore(root, values, snapshot):
    manifest = json.loads((snapshot / "manifest.json").read_text())
    if manifest.get("project") != "youthcapital" or manifest.get("database") != DATABASE:
        raise ValueError("Snapshot belongs to a different project/database")
    for name in ("database.dump", "media.tar.gz"):
        if digest(snapshot / name) != manifest["files"][name]:
            raise ValueError("Snapshot checksum mismatch")
    # Validate every media member before making any database or filesystem write.
    with tarfile.open(snapshot / "media.tar.gz", "r:gz") as archive:
        for member in archive.getmembers():
            safe_member(member)
        with (snapshot / "database.dump").open("rb") as stream:
            run_database(values, stream, restore=True)
        def project_filter(member, destination):
            member = tarfile.data_filter(member, destination)
            member.uid = member.gid = 10001
            member.uname = member.gname = None
            return member

        archive.extractall(root / "data", filter=project_filter, numeric_owner=True)
    print("Project database restored; media overlaid without deleting existing files")


def main(args):
    if len(args) < 2 or args[0] not in {"backup", "restore"}:
        raise ValueError("Expected backup root or restore root snapshot")
    os.umask(0o077)
    root = Path(args[1]).resolve()
    values = settings(root)
    if args[0] == "backup" and len(args) == 2:
        backup(root, values)
    elif args[0] == "restore" and len(args) == 3:
        restore(root, values, Path(args[2]).resolve())
    else:
        raise ValueError("Invalid backup/restore arguments")


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError, tarfile.TarError):
        # Do not print arbitrary exception/connection details containing secrets.
        sys.exit("Project backup/restore failed; check configuration, snapshot, storage and app-role access")
