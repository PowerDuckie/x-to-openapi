import { CurlAdapter, XToOpenApi } from "../dist/index.js";
const api = new XToOpenApi().register(new CurlAdapter());
const r = await api.convert(
  "curl",
  `curl 'https://api.example.com/users/1?active=true'\ncurl 'https://api.example.com/users/2' -X POST -H 'Content-Type: application/json' --data '{"name":"Ada"}'`,
);
console.log(JSON.stringify(r.document, null, 2));
