# enfurl (CLI)

```bash
npx enfurl https://en.wikipedia.org/wiki/Arithmetic_coding        # -> UIw5UPywtJ8So
npx enfurl https://example.com/some/page --host furl.li            # -> https://furl.li/<code>
npx enfurl -d UIw5UPywtJ8So                                       # -> the URL
npx enfurl -d https://furl.li/UIw5UPywtJ8So                        # full links work too
npx enfurl --strip "https://shop.example/p?id=1&utm_source=x"     # drops tracking parameters
npx enfurl --bits https://example.com/                            # size estimate
npx enfurl --json ...
```

The code is the URL, compressed. Nothing is stored anywhere; the CLI never touches the network. Library: `@enfurl/codec`. MIT.
