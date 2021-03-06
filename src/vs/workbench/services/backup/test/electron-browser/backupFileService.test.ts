/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as platform from 'vs/base/common/platform';
import * as crypto from 'crypto';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'vs/base/common/path';
import * as pfs from 'vs/base/node/pfs';
import { URI as Uri } from 'vs/base/common/uri';
import { BackupFileService, BackupFilesModel, hashPath } from 'vs/workbench/services/backup/node/backupFileService';
import { LegacyFileService } from 'vs/workbench/services/files/node/fileService';
import { TextModel, createTextBufferFactory } from 'vs/editor/common/model/textModel';
import { TestContextService, TestTextResourceConfigurationService, TestEnvironmentService } from 'vs/workbench/test/workbenchTestServices';
import { getRandomTestPath } from 'vs/base/test/node/testUtils';
import { Workspace, toWorkspaceFolders } from 'vs/platform/workspace/common/workspace';
import { DefaultEndOfLine } from 'vs/editor/common/model';
import { snapshotToString } from 'vs/platform/files/common/files';
import { Schemas } from 'vs/base/common/network';
import { IWindowConfiguration } from 'vs/platform/windows/common/windows';
import { FileService2 } from 'vs/workbench/services/files2/common/fileService2';
import { NullLogService } from 'vs/platform/log/common/log';
import { DiskFileSystemProvider } from 'vs/workbench/services/files2/node/diskFileSystemProvider';
import { WorkbenchEnvironmentService } from 'vs/workbench/services/environment/node/environmentService';
import { parseArgs } from 'vs/platform/environment/node/argv';

const parentDir = getRandomTestPath(os.tmpdir(), 'vsctests', 'backupfileservice');
const backupHome = path.join(parentDir, 'Backups');
const workspacesJsonPath = path.join(backupHome, 'workspaces.json');

const workspaceResource = Uri.file(platform.isWindows ? 'c:\\workspace' : '/workspace');
const workspaceBackupPath = path.join(backupHome, hashPath(workspaceResource));
const fooFile = Uri.file(platform.isWindows ? 'c:\\Foo' : '/Foo');
const barFile = Uri.file(platform.isWindows ? 'c:\\Bar' : '/Bar');
const untitledFile = Uri.from({ scheme: Schemas.untitled, path: 'Untitled-1' });
const fooBackupPath = path.join(workspaceBackupPath, 'file', hashPath(fooFile));
const barBackupPath = path.join(workspaceBackupPath, 'file', hashPath(barFile));
const untitledBackupPath = path.join(workspaceBackupPath, 'untitled', hashPath(untitledFile));

class TestBackupEnvironmentService extends WorkbenchEnvironmentService {

	private config: IWindowConfiguration;

	constructor(workspaceBackupPath: string) {
		super(parseArgs(process.argv) as IWindowConfiguration, process.execPath);

		this.config = Object.create(null);
		this.config.backupPath = workspaceBackupPath;
	}

	get configuration(): IWindowConfiguration {
		return this.config;
	}
}

class TestBackupFileService extends BackupFileService {
	constructor(workspace: Uri, backupHome: string, workspacesJsonPath: string) {
		const fileService = new FileService2(new NullLogService());
		fileService.registerProvider(Schemas.file, new DiskFileSystemProvider(new NullLogService()));
		fileService.setLegacyService(new LegacyFileService(
			fileService,
			new TestContextService(new Workspace(workspace.fsPath, toWorkspaceFolders([{ path: workspace.fsPath }]))),
			TestEnvironmentService,
			new TestTextResourceConfigurationService(),
		));
		const environmentService = new TestBackupEnvironmentService(workspaceBackupPath);

		super(environmentService, fileService);
	}

	public toBackupResource(resource: Uri): Uri {
		return super.toBackupResource(resource);
	}
}

suite('BackupFileService', () => {
	let service: TestBackupFileService;

	setup(() => {
		service = new TestBackupFileService(workspaceResource, backupHome, workspacesJsonPath);

		// Delete any existing backups completely and then re-create it.
		return pfs.rimraf(backupHome, pfs.RimRafMode.MOVE).then(() => {
			return pfs.mkdirp(backupHome).then(() => {
				return pfs.writeFile(workspacesJsonPath, '');
			});
		});
	});

	teardown(() => {
		return pfs.rimraf(backupHome, pfs.RimRafMode.MOVE);
	});

	suite('hashPath', () => {
		test('should correctly hash the path for untitled scheme URIs', () => {
			const uri = Uri.from({
				scheme: 'untitled',
				path: 'Untitled-1'
			});
			const actual = hashPath(uri);
			// If these hashes change people will lose their backed up files!
			assert.equal(actual, '13264068d108c6901b3592ea654fcd57');
			assert.equal(actual, crypto.createHash('md5').update(uri.fsPath).digest('hex'));
		});

		test('should correctly hash the path for file scheme URIs', () => {
			const uri = Uri.file('/foo');
			const actual = hashPath(uri);
			// If these hashes change people will lose their backed up files!
			if (platform.isWindows) {
				assert.equal(actual, 'dec1a583f52468a020bd120c3f01d812');
			} else {
				assert.equal(actual, '1effb2475fcfba4f9e8b8a1dbc8f3caf');
			}
			assert.equal(actual, crypto.createHash('md5').update(uri.fsPath).digest('hex'));
		});
	});

	suite('getBackupResource', () => {
		test('should get the correct backup path for text files', () => {
			// Format should be: <backupHome>/<workspaceHash>/<scheme>/<filePathHash>
			const backupResource = fooFile;
			const workspaceHash = hashPath(workspaceResource);
			const filePathHash = hashPath(backupResource);
			const expectedPath = Uri.file(path.join(backupHome, workspaceHash, 'file', filePathHash)).fsPath;
			assert.equal(service.toBackupResource(backupResource).fsPath, expectedPath);
		});

		test('should get the correct backup path for untitled files', () => {
			// Format should be: <backupHome>/<workspaceHash>/<scheme>/<filePath>
			const backupResource = Uri.from({ scheme: Schemas.untitled, path: 'Untitled-1' });
			const workspaceHash = hashPath(workspaceResource);
			const filePathHash = hashPath(backupResource);
			const expectedPath = Uri.file(path.join(backupHome, workspaceHash, 'untitled', filePathHash)).fsPath;
			assert.equal(service.toBackupResource(backupResource).fsPath, expectedPath);
		});
	});

	suite('loadBackupResource', () => {
		test('should return whether a backup resource exists', () => {
			return pfs.mkdirp(path.dirname(fooBackupPath)).then(() => {
				fs.writeFileSync(fooBackupPath, 'foo');
				service = new TestBackupFileService(workspaceResource, backupHome, workspacesJsonPath);
				return service.loadBackupResource(fooFile).then(resource => {
					assert.ok(resource);
					assert.equal(path.basename(resource!.fsPath), path.basename(fooBackupPath));
					return service.hasBackups().then(hasBackups => {
						assert.ok(hasBackups);
					});
				});
			});
		});
	});

	suite('backupResource', () => {
		test('text file', function () {
			return service.backupResource(fooFile, createTextBufferFactory('test').create(DefaultEndOfLine.LF).createSnapshot(false)).then(() => {
				assert.equal(fs.readdirSync(path.join(workspaceBackupPath, 'file')).length, 1);
				assert.equal(fs.existsSync(fooBackupPath), true);
				assert.equal(fs.readFileSync(fooBackupPath), `${fooFile.toString()}\ntest`);
			});
		});

		test('untitled file', function () {
			return service.backupResource(untitledFile, createTextBufferFactory('test').create(DefaultEndOfLine.LF).createSnapshot(false)).then(() => {
				assert.equal(fs.readdirSync(path.join(workspaceBackupPath, 'untitled')).length, 1);
				assert.equal(fs.existsSync(untitledBackupPath), true);
				assert.equal(fs.readFileSync(untitledBackupPath), `${untitledFile.toString()}\ntest`);
			});
		});

		test('text file (ITextSnapshot)', function () {
			const model = TextModel.createFromString('test');

			return service.backupResource(fooFile, model.createSnapshot()).then(() => {
				assert.equal(fs.readdirSync(path.join(workspaceBackupPath, 'file')).length, 1);
				assert.equal(fs.existsSync(fooBackupPath), true);
				assert.equal(fs.readFileSync(fooBackupPath), `${fooFile.toString()}\ntest`);
				model.dispose();
			});
		});

		test('untitled file (ITextSnapshot)', function () {
			const model = TextModel.createFromString('test');

			return service.backupResource(untitledFile, model.createSnapshot()).then(() => {
				assert.equal(fs.readdirSync(path.join(workspaceBackupPath, 'untitled')).length, 1);
				assert.equal(fs.existsSync(untitledBackupPath), true);
				assert.equal(fs.readFileSync(untitledBackupPath), `${untitledFile.toString()}\ntest`);
				model.dispose();
			});
		});

		test('text file (large file, ITextSnapshot)', function () {
			const largeString = (new Array(10 * 1024)).join('Large String\n');
			const model = TextModel.createFromString(largeString);

			return service.backupResource(fooFile, model.createSnapshot()).then(() => {
				assert.equal(fs.readdirSync(path.join(workspaceBackupPath, 'file')).length, 1);
				assert.equal(fs.existsSync(fooBackupPath), true);
				assert.equal(fs.readFileSync(fooBackupPath), `${fooFile.toString()}\n${largeString}`);
				model.dispose();
			});
		});

		test('untitled file (large file, ITextSnapshot)', function () {
			const largeString = (new Array(10 * 1024)).join('Large String\n');
			const model = TextModel.createFromString(largeString);

			return service.backupResource(untitledFile, model.createSnapshot()).then(() => {
				assert.equal(fs.readdirSync(path.join(workspaceBackupPath, 'untitled')).length, 1);
				assert.equal(fs.existsSync(untitledBackupPath), true);
				assert.equal(fs.readFileSync(untitledBackupPath), `${untitledFile.toString()}\n${largeString}`);
				model.dispose();
			});
		});
	});

	suite('discardResourceBackup', () => {
		test('text file', function () {
			return service.backupResource(fooFile, createTextBufferFactory('test').create(DefaultEndOfLine.LF).createSnapshot(false)).then(() => {
				assert.equal(fs.readdirSync(path.join(workspaceBackupPath, 'file')).length, 1);
				return service.discardResourceBackup(fooFile).then(() => {
					assert.equal(fs.existsSync(fooBackupPath), false);
					assert.equal(fs.readdirSync(path.join(workspaceBackupPath, 'file')).length, 0);
				});
			});
		});

		test('untitled file', function () {
			return service.backupResource(untitledFile, createTextBufferFactory('test').create(DefaultEndOfLine.LF).createSnapshot(false)).then(() => {
				assert.equal(fs.readdirSync(path.join(workspaceBackupPath, 'untitled')).length, 1);
				return service.discardResourceBackup(untitledFile).then(() => {
					assert.equal(fs.existsSync(untitledBackupPath), false);
					assert.equal(fs.readdirSync(path.join(workspaceBackupPath, 'untitled')).length, 0);
				});
			});
		});
	});

	suite('discardAllWorkspaceBackups', () => {
		test('text file', function () {
			return service.backupResource(fooFile, createTextBufferFactory('test').create(DefaultEndOfLine.LF).createSnapshot(false)).then(() => {
				assert.equal(fs.readdirSync(path.join(workspaceBackupPath, 'file')).length, 1);
				return service.backupResource(barFile, createTextBufferFactory('test').create(DefaultEndOfLine.LF).createSnapshot(false)).then(() => {
					assert.equal(fs.readdirSync(path.join(workspaceBackupPath, 'file')).length, 2);
					return service.discardAllWorkspaceBackups().then(() => {
						assert.equal(fs.existsSync(fooBackupPath), false);
						assert.equal(fs.existsSync(barBackupPath), false);
						assert.equal(fs.existsSync(path.join(workspaceBackupPath, 'file')), false);
					});
				});
			});
		});

		test('untitled file', function () {
			return service.backupResource(untitledFile, createTextBufferFactory('test').create(DefaultEndOfLine.LF).createSnapshot(false)).then(() => {
				assert.equal(fs.readdirSync(path.join(workspaceBackupPath, 'untitled')).length, 1);
				return service.discardAllWorkspaceBackups().then(() => {
					assert.equal(fs.existsSync(untitledBackupPath), false);
					assert.equal(fs.existsSync(path.join(workspaceBackupPath, 'untitled')), false);
				});
			});
		});

		test('should disable further backups', function () {
			return service.discardAllWorkspaceBackups().then(() => {
				return service.backupResource(untitledFile, createTextBufferFactory('test').create(DefaultEndOfLine.LF).createSnapshot(false)).then(() => {
					assert.equal(fs.existsSync(workspaceBackupPath), false);
				});
			});
		});
	});

	suite('getWorkspaceFileBackups', () => {
		test('("file") - text file', () => {
			return service.backupResource(fooFile, createTextBufferFactory('test').create(DefaultEndOfLine.LF).createSnapshot(false)).then(() => {
				return service.getWorkspaceFileBackups().then(textFiles => {
					assert.deepEqual(textFiles.map(f => f.fsPath), [fooFile.fsPath]);
					return service.backupResource(barFile, createTextBufferFactory('test').create(DefaultEndOfLine.LF).createSnapshot(false)).then(() => {
						return service.getWorkspaceFileBackups().then(textFiles => {
							assert.deepEqual(textFiles.map(f => f.fsPath), [fooFile.fsPath, barFile.fsPath]);
						});
					});
				});
			});
		});

		test('("file") - untitled file', () => {
			return service.backupResource(untitledFile, createTextBufferFactory('test').create(DefaultEndOfLine.LF).createSnapshot(false)).then(() => {
				return service.getWorkspaceFileBackups().then(textFiles => {
					assert.deepEqual(textFiles.map(f => f.fsPath), [untitledFile.fsPath]);
				});
			});
		});

		test('("untitled") - untitled file', () => {
			return service.backupResource(untitledFile, createTextBufferFactory('test').create(DefaultEndOfLine.LF).createSnapshot(false)).then(() => {
				return service.getWorkspaceFileBackups().then(textFiles => {
					assert.deepEqual(textFiles.map(f => f.fsPath), ['Untitled-1']);
				});
			});
		});
	});

	test('resolveBackupContent', () => {
		test('should restore the original contents (untitled file)', () => {
			const contents = 'test\nand more stuff';
			service.backupResource(untitledFile, createTextBufferFactory(contents).create(DefaultEndOfLine.LF).createSnapshot(false)).then(() => {
				service.resolveBackupContent(service.toBackupResource(untitledFile)).then(factory => {
					assert.equal(contents, snapshotToString(factory!.create(platform.isWindows ? DefaultEndOfLine.CRLF : DefaultEndOfLine.LF).createSnapshot(true)));
				});
			});
		});

		test('should restore the original contents (text file)', () => {
			const contents = [
				'Lorem ipsum ',
				'dolor ?????? sit amet ',
				'consectetur ',
				'adipiscing ???? elit',
			].join('');

			service.backupResource(fooFile, createTextBufferFactory(contents).create(DefaultEndOfLine.LF).createSnapshot(false)).then(() => {
				service.resolveBackupContent(service.toBackupResource(untitledFile)).then(factory => {
					assert.equal(contents, snapshotToString(factory!.create(platform.isWindows ? DefaultEndOfLine.CRLF : DefaultEndOfLine.LF).createSnapshot(true)));
				});
			});
		});
	});
});

suite('BackupFilesModel', () => {
	test('simple', () => {
		const model = new BackupFilesModel();

		const resource1 = Uri.file('test.html');

		assert.equal(model.has(resource1), false);

		model.add(resource1);

		assert.equal(model.has(resource1), true);
		assert.equal(model.has(resource1, 0), true);
		assert.equal(model.has(resource1, 1), false);

		model.remove(resource1);

		assert.equal(model.has(resource1), false);

		model.add(resource1);

		assert.equal(model.has(resource1), true);
		assert.equal(model.has(resource1, 0), true);
		assert.equal(model.has(resource1, 1), false);

		model.clear();

		assert.equal(model.has(resource1), false);

		model.add(resource1, 1);

		assert.equal(model.has(resource1), true);
		assert.equal(model.has(resource1, 0), false);
		assert.equal(model.has(resource1, 1), true);

		const resource2 = Uri.file('test1.html');
		const resource3 = Uri.file('test2.html');
		const resource4 = Uri.file('test3.html');

		model.add(resource2);
		model.add(resource3);
		model.add(resource4);

		assert.equal(model.has(resource1), true);
		assert.equal(model.has(resource2), true);
		assert.equal(model.has(resource3), true);
		assert.equal(model.has(resource4), true);
	});

	test('resolve', () => {
		return pfs.mkdirp(path.dirname(fooBackupPath)).then(() => {
			fs.writeFileSync(fooBackupPath, 'foo');

			const model = new BackupFilesModel();

			return model.resolve(workspaceBackupPath).then(model => {
				assert.equal(model.has(Uri.file(fooBackupPath)), true);
			});
		});
	});

	test('get', () => {
		const model = new BackupFilesModel();

		assert.deepEqual(model.get(), []);

		const file1 = Uri.file('/root/file/foo.html');
		const file2 = Uri.file('/root/file/bar.html');
		const untitled = Uri.file('/root/untitled/bar.html');

		model.add(file1);
		model.add(file2);
		model.add(untitled);

		assert.deepEqual(model.get().map(f => f.fsPath), [file1.fsPath, file2.fsPath, untitled.fsPath]);
	});
});
