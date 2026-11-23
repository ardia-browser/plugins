import unittest
from types import SimpleNamespace

from ardia_cli.browse.commands import failed_navigation


class HttpsOnlyBlock(unittest.TestCase):
    def ctx(self):
        return SimpleNamespace(state=SimpleNamespace(extras={}))

    def test_a_blocked_http_address_says_why(self):
        error = failed_navigation(self.ctx(), "http://example.test/page", "net::ERR_BLOCKED_BY_CLIENT")
        self.assertIn("Ardia loads http:// addresses over https", error.message)
        self.assertIn("Try the https:// address", error.message)

    def test_an_https_block_or_abort_points_at_trusting_the_site_in_the_ad_blocker(self):
        for error_text in ("net::ERR_BLOCKED_BY_CLIENT", "net::ERR_ABORTED"):
            error = failed_navigation(self.ctx(), "https://www.example.test/page", error_text)
            self.assertTrue(error.message.startswith(f"Navigation to https://www.example.test/page failed: {error_text}. If Ardia's ad blocker stopped it"))
            self.assertIn("`ardia call sites.allowAds -p site=www.example.test`", error.message)

    def test_other_failures_keep_the_plain_error(self):
        error = failed_navigation(self.ctx(), "https://example.test/page", "net::ERR_CERT_DATE_INVALID")
        self.assertEqual(error.message, "Navigation to https://example.test/page failed: net::ERR_CERT_DATE_INVALID")


if __name__ == "__main__":
    unittest.main()
