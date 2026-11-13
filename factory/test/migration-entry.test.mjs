import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { emptyLedger, recordFactoryApp } from "../lib/protocol.mjs";
import { A, B } from "./fixtures.mjs";

test("the real entry preserves migration boundaries and uses the installation for active reconciliation", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "factory-migration-entry-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const shim = join(directory, "fetch.mjs"), seed = join(directory, "seed.json"), event = join(directory, "event.json");
  writeFileSync(seed, JSON.stringify(recordFactoryApp(emptyLedger("42"), { id: "123", login: "factory-app[bot]" })));
  writeFileSync(event, "{}");
  writeFileSync(shim, `
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const A=${JSON.stringify(A)}, B=${JSON.stringify(B)}, root='/repos/ntodd/project', requests=[];
const seed=JSON.parse(readFileSync(process.env.MIGRATION_SEED,'utf8'));
const digest=v=>createHash('sha1').update(JSON.stringify(v)).digest('hex');
const blobs=new Map(),trees=new Map(),commits=new Map();
function treeFor(files){const entries=Object.entries(files).map(([path,data])=>{const content=JSON.stringify(data),sha=digest(content);blobs.set(sha,content);return {path,sha,mode:'100644',type:'blob',size:Buffer.byteLength(content)}});const sha=digest(entries);trees.set(sha,entries);return sha}
const files={'repository.json':{schemaVersion:1,repositoryId:'42',factoryApp:seed.factoryApp,integration:null,items:Object.keys(seed.items).sort(),operations:Object.keys(seed.operations).sort()}};
for(const [key,item] of Object.entries(seed.items)) files['items/'+key+'.json']=item;
for(const [key,op] of Object.entries(seed.operations)) files['operations/'+key+'.json']=op;
let initialTree=treeFor(files),tip=digest({tree:initialTree});commits.set(tip,{tree:{sha:initialTree}});
process.on('exit',()=>{const rows=trees.get(commits.get(tip).tree.sha), data=Object.fromEntries(rows.map(r=>[r.path,JSON.parse(blobs.get(r.sha))]));const meta=data['repository.json'];writeFileSync(process.env.MIGRATION_RECORD,JSON.stringify({requests,state:{schemaVersion:1,repositoryId:'42',factoryApp:meta.factoryApp,integration:null,items:Object.fromEntries(meta.items.map(k=>[k,data['items/'+k+'.json']])),operations:Object.fromEntries(meta.operations.map(k=>[k,data['operations/'+k+'.json']]))}}))});
const issue={number:7,title:'Fix it',body:'Accepted task',state:'open',user:{login:'ntodd'},labels:[{name:'agent-done'}]};
const pr={number:9,title:'Legacy fix',body:'Fixes #7',state:'open',user:{login:'factory-app[bot]'},labels:[],head:{sha:B,ref:'agent-ready/issue-7',repo:{full_name:'ntodd/project'}},base:{sha:A,ref:'main'}};
const connection=nodes=>({nodes,pageInfo:{hasNextPage:false,endCursor:null}});
globalThis.fetch=async(url,options={})=>{const path=new URL(url).pathname, method=options.method??'GET',body=options.body?JSON.parse(options.body):null;
  const authorization=options.headers?.authorization;
  requests.push({method,path,credential:authorization==='Bearer private-job-token'?'job':authorization==='Bearer fake-installation-token'?'app':'jwt',...(path.endsWith('/access_tokens')?{permissions:body.permissions}: {})});
  if(method==='POST'&&path==='/graphql'){
    const q=body.query;if(/\\bmutation\\b/.test(q))throw new Error('Migration attempted a GraphQL mutation');let object;
    if(q.includes('closingIssuesReferences'))object={number:9,headRefOid:B,closingIssuesReferences:connection([{number:7,repository:{nameWithOwner:'ntodd/project'}}])};
    else if(q.includes('userContentEdits'))object={userContentEdits:connection([])};
    else if(q.includes('timelineItems'))object={timelineItems:connection([])};
    else if(q.includes('reviewThreads'))object={reviewThreads:connection([])};
    else if(q.includes('reviews('))object={reviews:connection([])};
    else throw new Error('Unexpected migration query');
    return Response.json({data:{repository:{[q.includes('issue(number:')?'issue':'pullRequest']:object}}});
  }
  if(method==='POST'&&path==='/app/installations/7/access_tokens'){
    const expected=process.env.ACTIVE_RUNTIME==='true'?{contents:'write',issues:'write',pull_requests:'write',actions:'write',checks:'read',statuses:'read'}:{contents:'write'};
    if(JSON.stringify(body.permissions)!==JSON.stringify(expected)||body.repositories.join(',')!=='project')throw new Error('Token exceeds the requested role');
    return Response.json({token:'fake-installation-token',expires_at:'2099-01-01T00:00:00Z'});
  }
  if(method==='POST'&&path===root+'/git/trees'){
    const data={};for(const row of body.tree){if(!/^(repository\\.json|items\\/(issue|pr):[1-9]\\d*\\.json)$/.test(row.path))throw new Error('Migration wrote executable/unexpected state');data[row.path]=JSON.parse(row.content)}
    return Response.json({sha:treeFor(data)});
  }
  if(method==='POST'&&path===root+'/git/commits'){if(body.parents.length!==1||body.parents[0]!==tip)throw new Error('Migration overwrote state ancestry');const sha=digest(body);commits.set(sha,{tree:{sha:body.tree}});return Response.json({sha})}
  if(method==='PATCH'&&path===root+'/git/refs/heads/factory-state'){if(body.force!==false)throw new Error('Migration forced state');tip=body.sha;return Response.json({object:{sha:tip}})}
  if(method!=='GET')throw new Error('Migration attempted a non-ledger write: '+method+' '+path);
  if(path===root)return Response.json({id:42,full_name:'ntodd/project',default_branch:'main'});
  if(path===root+'/git/ref/heads/main')return Response.json({object:{sha:A}});
  if(path===root+'/git/ref/heads/factory-state')return Response.json({object:{sha:tip}});
  if(path.startsWith(root+'/git/commits/'))return Response.json(commits.get(path.split('/').at(-1)));
  if(path.startsWith(root+'/git/trees/'))return Response.json({tree:trees.get(path.split('/').at(-1)),truncated:false});
  if(path.startsWith(root+'/git/blobs/'))return Response.json({encoding:'base64',content:Buffer.from(blobs.get(path.split('/').at(-1))).toString('base64')});
  if(path===root+'/contents/.github/factory.yml'){const content='trusted-users: [ntodd]';return Response.json({type:'file',encoding:'base64',size:content.length,content:Buffer.from(content).toString('base64')})}
  if(path===root+'/actions/runs/100/attempts/1')return Response.json({id:100,run_attempt:1,path:'.github/workflows/factory.yml',repository:{id:42},head_repository:{id:42},head_branch:'main',head_sha:A,status:'in_progress',event:'workflow_dispatch',actor:{login:'ntodd',type:'User'},triggering_actor:{login:'ntodd',type:'User'}});
  if(path===root+'/actions/workflows')return Response.json({workflows:[{id:1,path:'.github/workflows/agent-ready.yml',state:process.env.MIGRATION_LEGACY_STATE??'disabled_manually'}]});
  if(path===root+'/actions/workflows/1/runs')return Response.json({total_count:0,workflow_runs:[]});
  if(path===root+'/issues')return Response.json(process.env.ACTIVE_RUNTIME==='true'?[]:[issue]);
  if(path===root+'/pulls')return Response.json(process.env.ACTIVE_RUNTIME==='true'?[]:[pr]);
  if(path===root+'/rules/branches/main')return Response.json([]);
  if(path===root+'/issues/7')return Response.json(issue);
  if(path===root+'/pulls/9')return Response.json(pr);
  if(path===root+'/issues/7/events')return Response.json([{id:123,event:'labeled',label:{name:'agent-ready'},actor:{login:'ntodd'},created_at:'2026-11-11T12:00:00Z'}]);
  if(path.endsWith('/comments')||path.endsWith('/events'))return Response.json([]);
  if(path===root+'/installation')return Response.json({id:7});
  if(path==='/app')return Response.json({id:123,slug:'factory-app'});
  throw new Error('Unexpected migration read: '+path);
};`);
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const execute = (request, id, extra = {}) => {
    const output = join(directory, `${id}-output`), summary = join(directory, `${id}-summary`), record = join(directory, `${id}-record`);
    const result = spawnSync(process.execPath, ["--import", shim, fileURLToPath(new URL("../control/index.mjs", import.meta.url))], {
      encoding: "utf8", timeout: 15000, env: { GITHUB_REPOSITORY: "ntodd/project", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main", GITHUB_SHA: A,
        GITHUB_WORKFLOW_REF: "ntodd/project/.github/workflows/factory.yml@refs/heads/main", GITHUB_ACTOR: "ntodd", GITHUB_TRIGGERING_ACTOR: "ntodd",
        GITHUB_RUN_ID: "100", GITHUB_RUN_ATTEMPT: "1", FACTORY_TOOLING_SHA: B, FACTORY_TOOLING_REPOSITORY: "ntodd/github-actions",
        GITHUB_API_URL: "https://api.github.com", GITHUB_TOKEN: "private-job-token", GITHUB_EVENT_PATH: event,
        FACTORY_APP_ID: "123", FACTORY_APP_PRIVATE_KEY: pem, FACTORY_DRY_RUN: "true", FACTORY_REQUEST: JSON.stringify(request),
        RUNNER_TEMP: directory, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, MIGRATION_SEED: seed, MIGRATION_RECORD: record, ...extra },
    });
    const observed = JSON.parse(readFileSync(record, "utf8"));
    assert.equal(existsSync(output), false, "Migration must not authorize worker outputs");
    assert.doesNotMatch(result.stderr + (existsSync(summary) ? readFileSync(summary, "utf8") : ""), /PRIVATE KEY|private-job-token|fake-installation-token/);
    return { result, observed, report: existsSync(summary) ? JSON.parse(readFileSync(summary, "utf8").split("\n\n").slice(1).join("\n\n")) : null };
  };
  const planned = execute({ kind: "migrate", items: [{ issue: 7, prs: [9], disposition: "continue" }] }, "plan");
  assert.equal(planned.result.status, 0, planned.result.stderr); assert.equal(planned.report.status, "planned");
  assert.equal(planned.observed.requests.some((r) => r.method !== "GET" && r.path !== "/graphql"), false);
  assert.deepEqual(planned.observed.state.items, {});
  const activePlan = execute({ kind: "migrate" }, "active-plan", { FACTORY_DRY_RUN: "false", FACTORY_APP_PRIVATE_KEY: "must-not-be-used" });
  assert.equal(activePlan.result.status, 0, activePlan.result.stderr);
  assert.equal(activePlan.observed.requests.some((r) => r.method !== "GET" && r.path !== "/graphql"), false);
  const applied = execute(planned.report.applyRequest, "apply");
  assert.equal(applied.result.status, 0, applied.result.stderr); assert.equal(applied.report.status, "imported");
  assert.equal(applied.observed.state.items["issue:7"].prs[0].number, 9);
  assert.deepEqual(applied.observed.state.operations, {});
  const tokens = applied.observed.requests.filter((r) => r.path.endsWith("/access_tokens"));
  assert.equal(tokens.length, 1); assert.deepEqual(tokens[0].permissions, { contents: "write" });
  assert.equal(applied.observed.requests.filter((r) => r.method === "PATCH").length, 1);
  const untrusted = execute(planned.report.applyRequest, "untrusted", { GITHUB_ACTOR: "other", GITHUB_TRIGGERING_ACTOR: "other", FACTORY_APP_PRIVATE_KEY: "must-not-be-used" });
  assert.equal(untrusted.result.status, 1); assert.equal(untrusted.observed.requests.some((r) => r.path.endsWith("/access_tokens")), false);
  assert.deepEqual(untrusted.observed.state.items, {});
  const conflict = execute(planned.report.applyRequest, "conflict", { MIGRATION_LEGACY_STATE: "active", FACTORY_APP_PRIVATE_KEY: "must-not-be-used" });
  assert.equal(conflict.result.status, 1); assert.equal(conflict.observed.requests.some((r) => r.path.endsWith("/access_tokens")), false);
  assert.deepEqual(conflict.observed.state.items, {});
  const runtime = execute({ kind: "reconcile" }, "runtime", { FACTORY_DRY_RUN: "false", ACTIVE_RUNTIME: "true" });
  assert.equal(runtime.result.status, 0, runtime.result.stderr);
  assert.equal(runtime.report.outcomes.some((o) => o.status === "interrupted"), false);
  const mint = runtime.observed.requests.findIndex((r) => r.path.endsWith("/access_tokens"));
  assert.ok(mint > 0);
  assert.ok(runtime.observed.requests.slice(0, mint).some((r) => r.path.endsWith("/actions/runs/100/attempts/1") && r.credential === "job"));
  for (const path of ["/repos/ntodd/project/issues", "/repos/ntodd/project/pulls", "/repos/ntodd/project/rules/branches/main"]) {
    const requests = runtime.observed.requests.filter((r) => r.path === path);
    assert.ok(requests.length > 0); assert.ok(requests.every((r) => r.credential === "app"));
  }
  const deniedRuntime = execute({ kind: "reconcile" }, "denied-runtime", { FACTORY_DRY_RUN: "false", ACTIVE_RUNTIME: "true", GITHUB_SHA: B });
  assert.equal(deniedRuntime.result.status, 1);
  assert.equal(deniedRuntime.observed.requests.some((r) => r.path.endsWith("/access_tokens")), false);
});
