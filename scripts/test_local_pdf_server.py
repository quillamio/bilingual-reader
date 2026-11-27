import unittest
from unittest.mock import patch
from pathlib import Path
import local_pdf_server as s
class BridgeTest(unittest.TestCase):
    def test_fixed_commands(self):
        with patch.object(s.shutil,"which",return_value="/bin/tool"):
            for engine in s.ENGINES:
                for mode in ("mono","dual"):
                    args=s.command(engine,mode,Path("document.pdf"),Path("out"),Path("local.toml"))
                    self.assertIn("--no-dual" if mode=="mono" else "--no-mono",args)
                    self.assertIn("zh-CN",args)
                    self.assertEqual(args[0],"/bin/tool")
    def test_missing_binary(self):
        with patch.object(s.shutil,"which",return_value=None):
            with self.assertRaises(RuntimeError):
                s.command("babeldoc","mono",Path("in.pdf"),Path("out"),Path("cfg"))
if __name__=="__main__":
    unittest.main()
