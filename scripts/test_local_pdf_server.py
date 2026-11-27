import unittest
import http.client
import threading
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
    def test_real_http_auth_and_reject_invalid_parameters(self):
        server=s.HTTPServer(("127.0.0.1",0),s.Handler)
        server.token="test-token-"+"x"*24
        thread=threading.Thread(target=server.serve_forever,daemon=True)
        thread.start()
        data=b"%PDF-1.7\nhello\n%%EOF"
        def req(method,path,token=None,body=None,extra=None):
            headers=dict(extra or {})
            if token is not None: headers["Authorization"]="Bearer "+token
            conn=http.client.HTTPConnection("127.0.0.1",server.server_port,timeout=3)
            try:
                conn.request(method,path,body=body,headers=headers)
                response=conn.getresponse()
                return response.status,response.read()
            finally: conn.close()
        try:
            with patch.object(s,"translated_pdf",return_value=data) as translate:
                self.assertEqual(req("GET","/health")[0],401)
                self.assertEqual(req("GET","/health",server.token)[0],200)
                headers={"Content-Type":"application/pdf"}
                route="/translate?engine=babeldoc&output=mono"
                self.assertEqual(req("POST",route,"wrong",data,headers)[0],401)
                self.assertEqual(req("POST",route+"&command=sh",server.token,data,headers)[0],400)
                self.assertEqual(req("POST",route+"&engine=pdf2zh-next",server.token,data,headers)[0],400)
                self.assertEqual(req("POST",route,server.token,b"not a valid PDF!",headers)[0],400)
                self.assertEqual(req("POST",route,server.token,data,{"Content-Type":"text/plain"})[0],413)
                translate.assert_not_called()
                self.assertEqual(req("POST",route,server.token,data,headers),(200,data))
                translate.assert_called_once_with("babeldoc","mono",data)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)
if __name__=="__main__":
    unittest.main()
