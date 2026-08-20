import os
import sys
import unittest


HERE = os.path.dirname(os.path.dirname(__file__))
sys.path.insert(0, HERE)

from mcp_stdio_server import process_request
from mcp_http_local import app


class StdioServerTest(unittest.TestCase):
    def test_initialize_is_standalone_and_requires_no_credentials(self):
        response = process_request({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {"protocolVersion": "2025-06-18"},
        })

        self.assertEqual(response["result"]["protocolVersion"], "2025-06-18")
        self.assertEqual(response["result"]["serverInfo"]["name"], "Légifrance MCP")

    def test_exhaustive_tools_are_discoverable_without_credentials(self):
        response = process_request({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/list",
            "params": {},
        })
        names = {tool["name"] for tool in response["result"]["tools"]}

        self.assertIn("Build_Research_Corpus", names)
        self.assertIn("Validate_Research_Cards", names)
        build_tool = next(
            tool for tool in response["result"]["tools"]
            if tool["name"] == "Build_Research_Corpus"
        )
        self.assertEqual(
            build_tool["inputSchema"]["properties"]["batch_max_decisions"]["default"],
            30,
        )

    def test_http_adapter_reuses_protocol_core(self):
        client = app.test_client()
        response = client.post("/mcp", json={
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/list",
            "params": {},
        })

        self.assertEqual(response.status_code, 200)
        names = {tool["name"] for tool in response.json["result"]["tools"]}
        self.assertIn("Build_Research_Corpus", names)

    def test_http_health_identifies_standalone_server(self):
        response = app.test_client().get("/health")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["server"], "Légifrance MCP")


if __name__ == "__main__":
    unittest.main()
