"""Regression checks for index measurement accounting (G4, V2)."""
import argparse
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location('index_probe', Path(__file__).with_name('index-efficiency-probe.py'))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class SearchMeasurementTests(unittest.TestCase):
    case = {'id': 'fixture', 'path': 'sample.rs', 'query': 'function', 'expected': 'fn function('}

    def rpc(self, results):
        self.calls = []
        iterator = iter(results)

        def call(method, params):
            self.calls.append((method, params))
            return {'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}, {
                'jsonrpc': '2.0', 'id': 1, 'result': next(iterator)}
        return call

    def result(self, covered=True, stale=None, truncated=False):
        return {'content': [{'type': 'text', 'text': json.dumps({'result': {
            'hits': [{'relativePath': 'sample.rs', 'excerpt': 'fn function(PRIVATE_SOURCE_MARKER'}] if covered else [],
            'staleFiles': stale or [], 'truncated': truncated}})}]}

    def test_v2_single_search_counts_full_envelopes_without_source(self):
        rpc = self.rpc([self.result()])
        with patch.object(probe.time, 'monotonic', side_effect=[2, 2.125]):
            row = probe.measure_search(rpc, self.case, b'whole file', 1)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(row['fullFileBytesProxy'], 10)
        self.assertTrue(row['covered'])
        self.assertEqual(row['searchMs'], 125)
        method, params = self.calls[0]
        request = {'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}
        response = {'jsonrpc': '2.0', 'id': 1, 'result': self.result()}
        self.assertEqual(row['requestBytes'], len(probe.encoded(request)))
        self.assertEqual(row['responseBytes'], len(probe.encoded(response)))
        self.assertNotIn('PRIVATE_SOURCE_MARKER', json.dumps(row))  # G4

    def test_v2_later_missing_hit_and_safety_flags_are_not_hidden(self):
        rpc = self.rpc([self.result(), self.result(False, ['changed.rs'], True), self.result()])
        with patch.object(probe.time, 'monotonic', side_effect=[1, 1.1, 2, 2.2, 3, 3.3]):
            row = probe.measure_search(rpc, self.case, b'file', 3)
        self.assertEqual(len(self.calls), 3)
        self.assertFalse(row['covered'])
        self.assertEqual(row['staleFiles'], 1)
        self.assertTrue(row['truncated'])
        self.assertEqual([s['covered'] for s in row['searchSamples']], [True, False, True])
        self.assertEqual([s['searchMs'] for s in row['searchSamples']], [100, 200, 300])
        self.assertEqual(row['searchMs'], 100)
        self.assertEqual(row['responseBytes'], row['searchSamples'][0]['responseBytes'])

    def test_v2_later_tool_error_fails_measurement(self):
        rpc = self.rpc([self.result(), {'isError': True, 'content': []}])
        with self.assertRaisesRegex(RuntimeError, 'MCP search failed for fixture'):
            probe.measure_search(rpc, self.case, b'file', 2)
        self.assertEqual(len(self.calls), 2)

    def test_v2_repeat_budget_is_bounded(self):
        for value in ('0', '-1', '21'):
            with self.subTest(value=value), self.assertRaises(argparse.ArgumentTypeError):
                probe.search_repeat_count(value)
        for value in ('1', '20'):
            self.assertEqual(probe.search_repeat_count(value), int(value))
        with self.assertRaises(ValueError):
            probe.search_repeat_count('not-a-number')


if __name__ == '__main__':
    unittest.main()
