const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const serverValidation = require('../cloudfunctions/youpuOpsApi/example-validation');
let adminValidation;

function normalizeLikeOpsRequest(content, previous) {
  const source = fs.readFileSync(path.join(root, 'cloudfunctions/youpuOpsApi/index.js'), 'utf8');
  const start = source.indexOf('class OpsError extends Error');
  const end = source.indexOf('\nfunction hash(', start);
  assert.ok(start >= 0 && end > start);
  const context = { crypto, exampleValidation: serverValidation, result: null };
  vm.runInNewContext(source.slice(start, end) + '\nresult = normalizeExampleContent;', context);
  return context.result(content, previous);
}

test.before(async function () {
  adminValidation = await import(pathToFileURL(path.join(root, 'admin/src/example-validation.js')).href);
});

function content(persons, relations) {
  return { family: { name: '测试示例' }, persons, relations };
}

function people(names) {
  return names.map(function (name, index) { return { _id: 'p' + index, name: name }; });
}

function largeExample(personCount, relationCount) {
  const persons = people(Array.from({ length: personCount }, function (_, index) { return '虚构人物' + index; }));
  const relations = [];
  for (let from = 0; from < personCount && relations.length < relationCount; from += 1) {
    for (let to = from + 1; to < personCount && relations.length < relationCount; to += 1) {
      relations.push({
        _id: 'r' + relations.length,
        type: 'parent_child',
        fromPersonId: 'p' + from,
        toPersonId: 'p' + to
      });
    }
  }
  assert.equal(relations.length, relationCount);
  return content(persons, relations);
}

test('有效的示例家谱不产生校验错误，前后端结果一致', function () {
  const value = content(people(['甲', '乙', '丙']), [
    { _id: 'r1', type: 'spouse', fromPersonId: 'p0', toPersonId: 'p1' },
    { _id: 'r2', type: 'parent_child', fromPersonId: 'p0', toPersonId: 'p2' }
  ]);
  assert.deepEqual(adminValidation.validateExampleContent(value), []);
  assert.deepEqual(serverValidation.validateExampleContent(value), []);
});

test('保存接口接受实际提交的姓名关系并生成稳定内部 ID', function () {
  const persons = people(Array.from({ length: 50 }, function (_, index) { return '虚构人物' + index; }));
  const relations = Array.from({ length: 79 }, function (_, index) {
    return {
      _id: 'local-relation-' + index,
      type: 'parent_child',
      fromPersonName: '虚构人物' + (index < 49 ? index : index - 49),
      toPersonName: '虚构人物' + (index < 49 ? 49 : 48)
    };
  });
  const result = normalizeLikeOpsRequest(content(persons, relations));
  assert.equal(result.persons.length, 50);
  assert.equal(result.relations.length, 79);
  assert.ok(result.relations.every(function (relation) {
    return relation.fromPersonId.startsWith('example_person_') &&
      relation.toPersonId.startsWith('example_person_') &&
      relation._id.startsWith('example_relation_');
  }));
  assert.ok(relations.every(function (relation) { return !('fromPersonId' in relation) && !('toPersonId' in relation); }));
  const savedAgain = normalizeLikeOpsRequest(content(persons, relations), result);
  assert.deepEqual(
    savedAgain.persons.map(function (person) { return person._id; }),
    result.persons.map(function (person) { return person._id; })
  );
  assert.deepEqual(
    savedAgain.relations.map(function (relation) { return relation._id; }),
    result.relations.map(function (relation) { return relation._id; })
  );
});

test('姓名关系未唯一匹配时保留原始姓名和 Excel 行号', function () {
  const value = content(people(['甲', '甲', '乙']), [
    { type: 'spouse', fromPersonName: '甲', toPersonName: '乙' },
    { type: 'parent_child', fromPersonName: '不存在', toPersonName: '乙' }
  ]);
  assert.throws(function () { normalizeLikeOpsRequest(value); }, function (error) {
    const issues = error.details && error.details.validationIssues;
    assert.ok(issues.some(function (item) { return item.code === 'EXAMPLE_PERSON_NAME_DUPLICATE'; }));
    assert.ok(issues.some(function (item) { return item.rowIndex === 0 && item.field === 'fromPersonId' && /甲/.test(item.message); }));
    assert.ok(issues.some(function (item) { return item.rowIndex === 1 && item.sheetRow === 3 && /不存在/.test(item.message); }));
    return true;
  });
});

test('保存接口继续接受只提交人物 ID 的旧关系格式', function () {
  const value = content(people(['甲', '乙', '丙']), [
    { type: 'spouse', fromPersonId: 'p0', toPersonId: 'p1' },
    { type: 'parent_child', fromPersonId: 'p0', toPersonId: 'p2' }
  ]);
  const result = normalizeLikeOpsRequest(value);
  assert.equal(result.relations.length, 2);
  assert.deepEqual(
    [result.relations[0].fromPersonId, result.relations[0].toPersonId].sort(),
    [result.persons[0]._id, result.persons[1]._id].sort()
  );
  assert.equal(result.relations[1].fromPersonId, result.persons[0]._id);
  assert.equal(result.relations[1].toPersonId, result.persons[2]._id);
});

test('姓名提交在人物未带 ID 时仍可匹配并保存', function () {
  const value = content([{ name: '甲' }, { name: '乙' }, { name: '丙' }], [
    { type: 'spouse', fromPersonName: '甲', toPersonName: '乙' },
    { type: 'parent_child', fromPersonName: '甲', toPersonName: '丙' }
  ]);
  const result = normalizeLikeOpsRequest(value);
  assert.equal(result.relations[1].fromPersonId, result.persons[0]._id);
  assert.equal(result.relations[1].toPersonId, result.persons[2]._id);
});

test('姓名提交仍能报告重复关系和祖先循环的关联行', function () {
  const value = content(people(['甲', '乙', '丙']), [
    { type: 'parent_child', fromPersonName: '甲', toPersonName: '乙' },
    { type: 'parent_child', fromPersonName: '乙', toPersonName: '丙' },
    { type: 'parent_child', fromPersonName: '丙', toPersonName: '甲' },
    { type: 'parent_child', fromPersonName: '甲', toPersonName: '乙' }
  ]);
  assert.throws(function () { normalizeLikeOpsRequest(value); }, function (error) {
    const issues = error.details && error.details.validationIssues;
    const duplicate = issues.find(function (item) { return item.code === 'EXAMPLE_RELATION_DUPLICATE'; });
    const cycle = issues.find(function (item) { return item.code === 'EXAMPLE_RELATION_CYCLE'; });
    assert.deepEqual(Array.from(duplicate.relatedRows), [0, 3]);
    assert.match(cycle.message, /甲 → 乙 → 丙 → 甲/);
    return true;
  });
});

test('一次列出缺少姓名、重复姓名、无效类型、缺失人物和自关联', function () {
  const value = content(people(['张三', '张三', '']), [
    { _id: 'r1', type: 'parent_child', fromPersonId: 'p0', toPersonId: 'p0' },
    { _id: 'r2', type: 'unknown', fromPersonId: '', fromName: '李四', toPersonId: 'missing', toName: '王五' }
  ]);
  const issues = adminValidation.validateExampleContent(value);
  const codes = issues.map(function (item) { return item.code; });
  assert.ok(codes.includes('EXAMPLE_PERSON_NAME_REQUIRED'));
  assert.ok(codes.includes('EXAMPLE_PERSON_NAME_DUPLICATE'));
  assert.ok(codes.includes('EXAMPLE_INVALID_RELATION'));
  assert.ok(codes.includes('EXAMPLE_RELATION_PERSON_NOT_FOUND'));
  assert.match(issues.find(function (item) { return item.code === 'EXAMPLE_PERSON_NAME_DUPLICATE'; }).message, /人物表第 1、2 行（Excel 第 2、3 行）/);
  assert.match(issues.find(function (item) { return item.field === 'fromPersonId'; }).message, /起始人物“李四”/);
  assert.match(issues.find(function (item) { return item.field === 'toPersonId' && item.rowIndex === 0; }).message, /不能与自己建立关系/);
  assert.deepEqual(serverValidation.validateExampleContent(value), issues);
});

test('重复关系标明全部关联行并可高亮每一行', function () {
  const value = content(people(['甲', '乙', '丙']), [
    { _id: 'r1', type: 'spouse', fromPersonId: 'p0', toPersonId: 'p1' },
    { _id: 'r2', type: 'spouse', fromPersonId: 'p1', toPersonId: 'p0' }
  ]);
  const issues = adminValidation.validateExampleContent(value);
  const duplicate = issues.find(function (item) { return item.code === 'EXAMPLE_RELATION_DUPLICATE'; });
  assert.deepEqual(duplicate.relatedRows, [0, 1]);
  assert.match(duplicate.message, /关系表第 1、2 行（Excel 第 2、3 行）/);
  assert.equal(adminValidation.issuesForRow(issues, 'relation', 0).includes(duplicate), true);
  assert.equal(adminValidation.issuesForRow(issues, 'relation', 1).includes(duplicate), true);
});

test('祖先循环列出具体人物路径和全部关系行', function () {
  const value = content(people(['甲', '乙', '丙']), [
    { _id: 'r1', type: 'parent_child', fromPersonId: 'p0', toPersonId: 'p1' },
    { _id: 'r2', type: 'parent_child', fromPersonId: 'p1', toPersonId: 'p2' },
    { _id: 'r3', type: 'parent_child', fromPersonId: 'p2', toPersonId: 'p0' }
  ]);
  const cycles = adminValidation.validateExampleContent(value).filter(function (item) { return item.code === 'EXAMPLE_RELATION_CYCLE'; });
  assert.equal(cycles.length, 1);
  assert.deepEqual(cycles[0].relatedRows, [0, 1, 2]);
  assert.match(cycles[0].message, /关系表第 1、2、3 行/);
  assert.match(cycles[0].message, /甲 → 乙 → 丙 → 甲/);
});

test('多个独立祖先循环全部返回', function () {
  const value = content(people(['甲', '乙', '丙', '丁', '戊', '己']), [
    { type: 'parent_child', fromPersonId: 'p0', toPersonId: 'p1' },
    { type: 'parent_child', fromPersonId: 'p1', toPersonId: 'p2' },
    { type: 'parent_child', fromPersonId: 'p2', toPersonId: 'p0' },
    { type: 'parent_child', fromPersonId: 'p3', toPersonId: 'p4' },
    { type: 'parent_child', fromPersonId: 'p4', toPersonId: 'p5' },
    { type: 'parent_child', fromPersonId: 'p5', toPersonId: 'p3' }
  ]);
  const cycles = adminValidation.validateExampleContent(value).filter(function (item) { return item.code === 'EXAMPLE_RELATION_CYCLE'; });
  assert.equal(cycles.length, 2);
  assert.deepEqual(cycles.map(function (item) { return item.relatedRows; }), [[0, 1, 2], [3, 4, 5]]);
});

test('199/399 与 200/400 边界通过校验且保存不丢失末尾记录', function () {
  for (const [personCount, relationCount] of [[199, 399], [200, 400]]) {
    const value = largeExample(personCount, relationCount);
    assert.deepEqual(adminValidation.validateExampleContent(value), []);
    assert.deepEqual(serverValidation.validateExampleContent(value), []);
    const saved = normalizeLikeOpsRequest(value);
    assert.equal(saved.persons.length, personCount);
    assert.equal(saved.relations.length, relationCount);
    assert.equal(saved.persons.at(-1).name, '虚构人物' + (personCount - 1));
    assert.equal(saved.relations.at(-1).toPersonId, saved.persons[Number(value.relations.at(-1).toPersonId.slice(1))]._id);
    const savedAgain = normalizeLikeOpsRequest(saved, saved);
    assert.equal(savedAgain.persons.length, personCount);
    assert.equal(savedAgain.relations.length, relationCount);
    assert.equal(savedAgain.persons.at(-1)._id, saved.persons.at(-1)._id);
    assert.equal(savedAgain.relations.at(-1)._id, saved.relations.at(-1)._id);
  }
});

test('201 人和 401 条关系分别明确拒绝，前后端错误一致', function () {
  for (const [personCount, relationCount, expectedCode, expectedMessage] of [
    [201, 400, 'EXAMPLE_MAX_PERSONS', '示例家谱最多支持 200 位人物'],
    [200, 401, 'EXAMPLE_MAX_RELATIONS', '示例家谱最多支持 400 条关系']
  ]) {
    const value = largeExample(personCount, relationCount);
    const adminIssues = adminValidation.validateExampleContent(value);
    const serverIssues = serverValidation.validateExampleContent(value);
    assert.deepEqual(serverIssues, adminIssues);
    assert.deepEqual(adminIssues.map(function (item) { return item.code; }), [expectedCode]);
    assert.match(adminIssues[0].message, new RegExp(expectedMessage));
    assert.throws(function () { normalizeLikeOpsRequest(value); }, function (error) {
      assert.equal(error.code, expectedCode);
      assert.equal(error.message, expectedMessage);
      assert.deepEqual(JSON.parse(JSON.stringify(error.details.validationIssues)), adminIssues);
      return true;
    });
  }
});

test('200 人和 400 条关系发布、回滚后用户端仍完整读取', async function () {
  const saved = normalizeLikeOpsRequest(largeExample(200, 400));
  const source = fs.readFileSync(path.join(root, 'cloudfunctions/youpuOpsApi/index.js'), 'utf8');
  const publishStart = source.indexOf('async function examplesPublish(');
  const publishEnd = source.indexOf('\nasync function examplesUnpublish(', publishStart);
  const rollbackStart = source.indexOf('async function examplesRollback(');
  const rollbackEnd = source.indexOf('\nasync function examplesArchive(', rollbackStart);
  assert.ok(publishStart >= 0 && publishEnd > publishStart && rollbackStart >= 0 && rollbackEnd > rollbackStart);

  const template = {
    _id: 'example-test', slug: 'example-test', title: '虚构示例', status: 'draft',
    draftContent: saved, publishedVersion: 0
  };
  const versions = new Map();
  const transaction = {
    collection: function (name) {
      return {
        doc: function (id) {
          return {
            set: async function ({ data }) { assert.equal(name, 'example_template_versions'); versions.set(id, data); },
            update: async function ({ data }) { assert.equal(name, 'example_templates'); assert.equal(id, template._id); Object.assign(template, data); }
          };
        }
      };
    }
  };
  const context = {
    result: null,
    requireOperator: async function () { return { _id: 'operator-test' }; },
    ensureExampleCollections: async function () {},
    opsMutate: async function (_, __, ___, callback) { return callback(transaction); },
    getExampleTemplate: async function () { return template; },
    findExampleDocument: async function (_, id) { return versions.get(id); },
    normalizeExampleContent: normalizeLikeOpsRequest,
    normalizeExampleDisplayPreference: function (_, fallback) { return fallback || {}; },
    writeRequiredExampleAudit: async function () {},
    assert: function (condition, code, message) { if (!condition) { const error = new Error(message); error.code = code; throw error; } },
    cleanText: function (value) { return String(value || ''); },
    hash: function (value, length) { return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length); },
    db: { serverDate: function () { return 'test-date'; } }
  };
  vm.runInNewContext(source.slice(publishStart, publishEnd) + source.slice(rollbackStart, rollbackEnd) +
    '\nresult = { publish: examplesPublish, rollback: examplesRollback };', context);

  const published = await context.result.publish({ templateId: template._id }, {});
  assert.equal(published.version, 1);
  const firstVersionId = Array.from(versions.keys())[0];
  assert.equal(template.publishedContent.persons.length, 200);
  assert.equal(template.publishedContent.relations.length, 400);
  assert.equal(versions.get(firstVersionId).snapshot.content.relations.length, 400);

  template.draftContent = normalizeLikeOpsRequest(content(saved.persons.slice(0, 3), saved.relations.slice(0, 2)));
  await context.result.publish({ templateId: template._id }, {});
  assert.equal(template.publishedContent.persons.length, 3);
  const rolledBack = await context.result.rollback({ templateId: template._id, versionId: firstVersionId }, {});
  assert.equal(rolledBack.version, 3);
  assert.equal(template.draftContent.persons.length, 200);
  assert.equal(template.publishedContent.relations.length, 400);

  const userSource = fs.readFileSync(path.join(root, 'cloudfunctions/youpuUserApi/index.js'), 'utf8');
  const publicContent = userSource.match(/function publicExampleContent\(template\) \{[\s\S]*?\n\}/);
  assert.ok(publicContent);
  const userContext = {
    template: template,
    result: null,
    cleanText: function (value) { return String(value || ''); },
    publicExamplePerson: function (person) { return person; }
  };
  vm.runInNewContext(publicContent[0] + '\nresult = publicExampleContent(template);', userContext);
  assert.equal(userContext.result.personCount, 200);
  assert.equal(userContext.result.relationCount, 400);
  assert.equal(userContext.result.persons.at(-1).name, '虚构人物199');
  assert.equal(userContext.result.relations.length, 400);
});
