import importlib.util
import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


class WebDataTest(unittest.TestCase):
    def test_generated_web_data_is_current(self):
        path = ROOT / "scripts" / "export_web_data.py"
        spec = importlib.util.spec_from_file_location("export_web_data", path)
        module = importlib.util.module_from_spec(spec)
        assert spec.loader
        spec.loader.exec_module(module)
        actual = (ROOT / "docs" / "data" / "app-data.json").read_text(encoding="utf-8")
        self.assertEqual(actual, module.render_data())

    def test_jeon_sangwon_is_promoted_to_a(self):
        data = json.loads((ROOT / "docs" / "data" / "app-data.json").read_text(encoding="utf-8"))
        member = next(item for item in data["members"] if item["name"] == "전상원")
        self.assertEqual(member["level"], "A")
        self.assertEqual(member["score"], data["levels"]["A"])


if __name__ == "__main__":
    unittest.main()
