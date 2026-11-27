import io
import json
import pathlib
import tarfile
import tempfile
import unittest
import build

class BuilderTests(unittest.TestCase):
    def test_four_platform_pins(self):
        self.assertEqual(len(build.PINS["targets"]),4)
        for pin in build.PINS["targets"].values():
            for k in ["pythonSha256","wheelSha256"]:
                self.assertRegex(pin[k],r"^[a-f0-9]{64}$")
    def test_tar_rejects_traversal_and_special_file(self):
        with tempfile.TemporaryDirectory() as d:
            p=pathlib.Path(d)
            for name,kind in [("python/../../outside",tarfile.REGTYPE),("python/device",tarfile.CHRTYPE),("python/escape",tarfile.SYMTYPE)]:
                with tarfile.open(p/"bad.tar.gz","w:gz") as t:
                    m=tarfile.TarInfo(name);m.type=kind
                    if kind==tarfile.SYMTYPE:m.linkname="../../outside"
                    t.addfile(m,io.BytesIO())
                dest=p/"output";dest.mkdir(exist_ok=True)
                with self.assertRaises((ValueError,tarfile.TarError)):build.safe_extract(p/"bad.tar.gz",dest)
                self.assertFalse((p/"outside").exists())
    def test_hash_lock_rejects_wrong_wheel(self):
        with tempfile.TemporaryDirectory() as d:
            p=pathlib.Path(d)/"report.json";pin=build.PINS["targets"]["macos-arm64"]
            row={"metadata":{"name":"BabelDOC","version":"0.7.1"},"download_info":{"url":"https://files.pythonhosted.org/babeldoc.whl","archive_info":{"hashes":{"sha256":pin["wheelSha256"]}}}}
            p.write_text(json.dumps({"install":[row]}))
            lock,meta=build.lock_from_report(p,"macos-arm64");self.assertIn("babeldoc==0.7.1 --hash=sha256:",lock)
            row["download_info"]["archive_info"]["hashes"]["sha256"]="0"*64;p.write_text(json.dumps({"install":[row]}))
            with self.assertRaises(ValueError):build.lock_from_report(p,"macos-arm64")
    def test_audited_lock_drift_rejected(self):
        with self.assertRaises(ValueError):build.verify_lock("changed==1.0\n","macos-arm64")
    def test_flat_archive_is_relocatable_and_verifies_members(self):
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d)/"source";root.mkdir()
            for sub in ("python","site"):(root/sub).mkdir()
            (root/"launcher.py").write_text("print('test')");(root/"requirements.lock").write_text("lock")
            (root/"python"/"python.exe").write_bytes(b"exe");(root/"site"/"module.py").write_text("x=1")
            archive=pathlib.Path(d)/"runtime.zip";meta=build.pack_installable(root,archive,"windows-x64")
            dest=pathlib.Path(d)/"installed 测试";dest.mkdir()
            build.unpack_installable(archive,dest,"windows-x64")
            self.assertEqual((dest/"site"/"module.py").read_text(),"x=1")
            self.assertEqual(meta["fileCount"],4)
            with self.assertRaises(ValueError):build.runtime_member("site/../outside")
            with self.assertRaises(ValueError):build.runtime_member("site/CON.txt")
            self.assertNotEqual(build.runtime_member("python/share/terminfo/2/2621A","linux-x64"),build.runtime_member("python/share/terminfo/2/2621a","linux-x64"))
            self.assertEqual(build.runtime_member("python/share/terminfo/2/2621A","macos-arm64"),build.runtime_member("python/share/terminfo/2/2621a","macos-arm64"))
if __name__=="__main__":unittest.main()
