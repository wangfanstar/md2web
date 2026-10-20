"""Isolated HTTP read-capacity probe. Never contacts SVN or modifies live documents."""
import json
import os
import platform
import sys
import threading
import time
from queue import Queue
from pathlib import Path
from urllib.request import urlopen
sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_plan_integration import PlanIntegrationTests
from waitress import create_server


def main():
    fixture = PlanIntegrationTests()
    fixture.setUp()
    server = None
    try:
        now = fixture.auth._stamp()
        with fixture.conn:
            fixture.conn.executemany(
                "INSERT INTO users(auth_source_id,svn_username,display_name,role,created_at) VALUES('benchmark',?,?,'user',?)",
                [('user-%d' % i, 'User %d' % i, now) for i in range(9999)])
        for i in range(300):
            (fixture.docs / 'md/old' / ('document-%d.md' % i)).write_text('# Document\n\nText.\n', encoding='utf-8')
        server = create_server(fixture.app, host='127.0.0.1', port=0, threads=8)
        thread = threading.Thread(target=server.run)
        thread.daemon = True
        thread.start()
        base = 'http://127.0.0.1:' + str(server.effective_port)
        report = dict(python=platform.python_version(), platform=platform.platform(), cpu=platform.processor(),
                      logicalCpus=os.cpu_count(), userRecords=10000, documents=301, waitressThreads=8,
                      scope='HTTP read probe; no SVN, save/build latency or production capacity claim', runs=[])
        for concurrency in (30, 100):
            urls = ['/__folder?path=md/old', '/__doc-meta?path=md/old/a.md', '/index.html']
            def request(i):
                started = time.perf_counter()
                try:
                    with urlopen(base + urls[i % len(urls)], timeout=20) as response:
                        body = response.read()
                        return time.perf_counter()-started, len(body), response.status
                except Exception:
                    return time.perf_counter()-started, 0, 0
            pending, output = Queue(), Queue()
            for i in range(concurrency*10):
                pending.put(i)
            for i in range(concurrency):
                pending.put(None)
            def worker():
                while True:
                    i = pending.get()
                    if i is None:
                        return
                    output.put(request(i))
            workers = [threading.Thread(target=worker) for _ in range(concurrency)]
            for worker_thread in workers:
                worker_thread.start()
            for worker_thread in workers:
                worker_thread.join()
            results = [output.get() for _ in range(concurrency*10)]
            latencies = sorted(r[0]*1000 for r in results)
            report['runs'].append(dict(concurrentClients=concurrency, requests=len(results),
                                       p50Ms=round(latencies[len(latencies)//2],2),
                                       p95Ms=round(latencies[int(len(latencies)*.95)-1],2),
                                       bytes=sum(r[1] for r in results), errors=sum(r[2]!=200 for r in results)))
        print(json.dumps(report, ensure_ascii=False, indent=2))
    finally:
        if server:
            server.close()
            server.task_dispatcher.shutdown()
        fixture.tearDown()


if __name__ == '__main__':
    main()
