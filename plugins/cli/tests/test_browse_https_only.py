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
        for url in ("https://www.example.test/page", "https://blocked.example.com\\@other.example.org/", "https://landing.example.test/"):
            for error_text in ("net::ERR_BLOCKED_BY_CLIENT", "net::ERR_ABORTED"):
                error = failed_navigation(self.ctx(), url, error_text)
                self.assertTrue(error.message.startswith(f"Navigation to {url} failed: {error_text}. If Ardia's ad blocker stopped it"))
                self.assertIn("`ardia call sites.allowAds -p site=<that host>`", error.message)
                self.assertNotIn("site=www.", error.message)

    def test_the_same_words_as_the_typescript_daemon(self):
        from ardia_cli.browse.commands import AD_BLOCKER_NOTE
        self.assertEqual(AD_BLOCKER_NOTE, "If Ardia's ad blocker stopped it (the tab shows uBlock Origin's \"Page blocked\" page, which names the blocked host), `ardia call sites.allowAds -p site=<that host>` trusts the site, where Ardia offers that method (`ardia methods` lists it); then open the page again")

    def test_other_failures_keep_the_plain_error(self):
        error = failed_navigation(self.ctx(), "https://example.test/page", "net::ERR_CERT_DATE_INVALID")
        self.assertEqual(error.message, "Navigation to https://example.test/page failed: net::ERR_CERT_DATE_INVALID")


if __name__ == "__main__":
    unittest.main()
