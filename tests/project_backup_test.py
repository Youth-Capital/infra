import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "project_backup", Path(__file__).resolve().parents[1] / "scripts/project_backup.py")
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


class ProjectBackupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / "runtime").mkdir()
        (self.root / "runtime/backend.env").write_text(
            "DB_NAME=yoshlar_kapitali_db\nDB_USER=yoshlar_kapitali_user\n"
            "DB_HOST=postgres\nDB_PORT=5432\nPOSTGRES_PASSWORD=test-only-$#'password\n")
        for name in ("media", "private-media", "private-media/.tmp"):
            (self.root / "data" / name).mkdir(parents=True, exist_ok=True)
        (self.root / "data/media/photo.txt").write_text("public")
        (self.root / "data/private-media/private.txt").write_text("private")
        (self.root / "data/private-media/.tmp/upload.txt").write_text("scratch")
        self.values = backup.settings(self.root)

    def test_database_commands_use_only_project_role_and_database(self):
        for restore in (False, True):
            command = backup.database_command(self.values, restore)
            self.assertIn("--username=yoshlar_kapitali_user", command)
            self.assertIn("--dbname=yoshlar_kapitali_db", command)
            self.assertNotIn("--create", command)
            self.assertNotIn(self.values["POSTGRES_PASSWORD"], " ".join(command))
        self.assertIn("--single-transaction", backup.database_command(self.values, True))

    def test_other_database_or_role_is_rejected(self):
        file = self.root / "runtime/backend.env"
        file.write_text(file.read_text().replace("yoshlar_kapitali_db", "agrozanjir_db"))
        with self.assertRaises(ValueError):
            backup.settings(self.root)

    def snapshot(self):
        def dump(values, stream, restore=False):
            self.assertFalse(restore)
            stream.write(b"fixture dump")
        with patch.object(backup, "run_database", side_effect=dump):
            backup.backup(self.root, self.values)
        return next((self.root / "backups").iterdir())

    def test_roundtrip_excludes_scratch_and_keeps_unrelated_media(self):
        snapshot = self.snapshot()
        with tarfile.open(snapshot / "media.tar.gz") as archive:
            self.assertEqual(set(archive.getnames()), {
                "media", "media/photo.txt", "private-media", "private-media/private.txt"})
        (self.root / "data/media/photo.txt").write_text("changed")
        (self.root / "data/media/new.txt").write_text("keep")
        with patch.object(backup, "run_database") as database:
            backup.restore(self.root, self.values, snapshot)
        self.assertTrue(database.call_args.kwargs["restore"])
        self.assertEqual((self.root / "data/media/photo.txt").read_text(), "public")
        self.assertEqual((self.root / "data/media/new.txt").read_text(), "keep")

    def test_tampered_snapshot_fails_before_database_write(self):
        snapshot = self.snapshot()
        (snapshot / "database.dump").write_bytes(b"corrupt")
        with patch.object(backup, "run_database") as database, self.assertRaises(ValueError):
            backup.restore(self.root, self.values, snapshot)
        database.assert_not_called()

    def test_unsafe_archive_fails_before_database_write(self):
        snapshot = self.snapshot()
        with tarfile.open(snapshot / "media.tar.gz", "w:gz") as archive:
            entry = tarfile.TarInfo("media/../../other-project.txt")
            entry.size = 4
            archive.addfile(entry, io.BytesIO(b"evil"))
        manifest = json.loads((snapshot / "manifest.json").read_text())
        manifest["files"]["media.tar.gz"] = backup.digest(snapshot / "media.tar.gz")
        (snapshot / "manifest.json").write_text(json.dumps(manifest))
        with patch.object(backup, "run_database") as database, self.assertRaises(ValueError):
            backup.restore(self.root, self.values, snapshot)
        database.assert_not_called()


if __name__ == "__main__":
    unittest.main()
