/// <reference path="../../vendor/pocketjs/framework/compiler/ambient.d.ts" />
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadAppFeatures, specializeAppSource, filterFeatureResource } from "../../vendor/pocketjs/framework/compiler/app-features";
import { transformFile } from "../../vendor/pocketjs/framework/compiler/jsx-plugin";
import registry from "../../pocket.features.json";

const root = resolve(import.meta.dir, "../..");
const dir = realpathSync(mkdtempSync(join(tmpdir(), "transport-features-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const kinds = { serial: "serial", tcp: "tcp-client", tcps: "tcp-server", udp: "udp", ws: "websocket" } as const;

for (const selected of ["all", "none", ...Object.keys(kinds)]) test(`transport specialization: ${selected}`, async () => {
  const values = { ...registry.profiles["transport-all"] };
  for (const [kind, feature] of Object.entries(kinds)) values[`transport.${feature}` as keyof typeof values] = selected === "all" || kind === selected;
  const config = join(dir, `${selected}.json`);
  await Bun.write(config, JSON.stringify({
    ...registry,
    resources: registry.resources.map(file => join(root, file)),
    features: Object.fromEntries(Object.entries(registry.features).map(([name, definition]) => [name, {
      ...definition,
      ...("modules" in definition ? { modules: definition.modules.map(file => join(root, file)) } : {}),
    }])),
    profiles: { test: values },
  }));
  const features = await loadAppFeatures(config, "test");
  for (const file of ["app/panel.tsx", "app/transfer.tsx"]) {
    const result = await transformFile(join(root, file), await Bun.file(join(root, file)).text(), "vue-vapor", { appFeatures: features });
    for (const [kind, marker] of Object.entries({ tcp: 't("conn.tcpClient")', tcps: 't("conn.tcpServer")', udp: 't("conn.udp")', ws: 't("conn.wsClient")', serial: 't("conn.serial")' })) {
      if (file.endsWith("panel.tsx")) expect(result.code.includes(marker)).toBe(selected === "all" || selected === kind);
    }
  }
  const pack = await Bun.file(join(root, "assets/i18n/en.json")).json();
  const filtered = filterFeatureResource(pack, features) as typeof pack;
  for (const [kind, label] of Object.entries({ serial: "serial", tcp: "tcpClient", tcps: "tcpServer", udp: "udp", ws: "wsClient" }))
    expect(Object.hasOwn(filtered.conn, label)).toBe(selected === "all" || selected === kind);

  const output = join(dir, `${selected}.mjs`);
  const build = await Bun.build({ entrypoints: [join(root, "app/session.ts")], target: "bun", format: "esm",
    plugins: [{ name: "transport-specialize", setup(builder) {
      builder.onLoad({ filter: /(?:app|bridge)\/.*\.ts$/ }, async ({ path }) => ({
        contents: await specializeAppSource(path, await Bun.file(path).text(), features), loader: "ts",
      }));
      builder.onResolve({ filter: /^@pocketjs\/framework$/ }, () => ({ path: "framework", namespace: "stub" }));
      builder.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: 'export const getOps = () => ({measureText: s => s.length * 8});', loader: "js" }));
    } }],
  });
  expect(build.success).toBe(true);
  await Bun.write(output, build.outputs[0]!);
  const script = `
    import { strict as a } from "node:assert";
    const enabled = ${JSON.stringify(selected)};
    const calls=[];
    let exported;
    const lastConn = {
      serial:{path:"/dev/probe",baudRate:9600,dataBits:8,parity:"none",stopBits:1,flowControl:"none",dtr:false,rts:false},
      tcp:{host:"localhost",port:9001,autoReconnect:false,reconnectSec:5}, tcps:{port:9002},
      udp:{bindPort:9003,host:"localhost",port:9004}, ws:{url:"ws://localhost:9005",autoReconnect:false,reconnectSec:5}
    };
    globalThis.com={write:()=>true,close:()=>true,poll:()=>null,
      cfgRead:()=>JSON.stringify({version:1,lastConn}),cfgWrite:()=>true,
      cfgExport:json=>{exported=JSON.parse(json);return '{"ok":true}'},
    };
    for (const [kind,op] of Object.entries({serial:"serialOpen",tcp:"tcpConnect",tcps:"tcpListen",udp:"udpBind",ws:"wsConnect"})) {
      if (enabled === "all" || enabled === kind) globalThis.com[op]=json=>{calls.push({kind,params:JSON.parse(json)});return '{"handle":1}'};
    }
    // Network-only hosts deliberately have no serial operations.
    if(enabled==="all"||enabled==="serial") {globalThis.com.serialList=()=>"[]";globalThis.com.setSignals=()=>true;}
    const s=await import(${JSON.stringify(output)});
    a.equal(s.comAvailable,true);
    const fields={serial:["portPath","baud","ports"],tcp:["tcpHost","tcpPort","tcpAutoReconnect"],tcps:["tcpsPort","clientList"],udp:["udpHost","udpPort","udpBindPort"],ws:["wsUrl","wsAutoReconnect"]};
    for(const [kind,names] of Object.entries(fields)) for(const name of names) a.equal(s[name]!==undefined,enabled==="all"||enabled===kind,name);
    const initial=enabled==="all"?"serial":enabled==="none"?"loopback":enabled;
    a.equal(s.connType.value,initial);
    const params={tcp:{kind:"tcp",host:"localhost",port:9000},tcps:{kind:"tcps",port:9000},udp:{kind:"udp",bindPort:9000,host:"localhost",port:9001},ws:{kind:"ws",url:"ws://localhost"}};
    for(const kind of Object.keys(fields)) {
      const active=enabled==="all"||enabled===kind;
      s.setConnType(kind);
      if(!active) {
        a.notEqual(s.connType.value,kind);
        const before=calls.length;
        a.throws(()=>kind==="serial"?s.session.openSerial(lastConn.serial):s.session.openNet(params[kind]),/transport disabled/);
        a.equal(s.session.state,"DISCONNECTED"); a.equal(calls.length,before);
        if(kind!=="serial") a.equal(s.com.netOpen(params[kind]),null);
      } else {
        a.equal(s.connType.value,kind);
        if(kind!=="serial") {
          a.equal(s.com.netOpen({...params[kind],autoReconnect:true,reconnectSec:3}).ok,true);
          a.equal(calls.at(-1).kind,kind);
          a.equal("kind" in calls.at(-1).params,false);
          a.equal("autoReconnect" in calls.at(-1).params,false);
          a.equal("reconnectSec" in calls.at(-1).params,false);
        }
      }
    }
    s.setConnType("loopback"); a.equal(s.openCurrentConnection(),true);s.closeConnection();
    s.exportConfig();a.deepEqual(exported.lastConn,lastConn);
    s.pumpSession(0);
  `;
  const child = Bun.spawnSync([process.execPath, "-e", script], { cwd: root });
  expect(child.stderr.toString()).toBe("");
  expect(child.exitCode).toBe(0);
});
