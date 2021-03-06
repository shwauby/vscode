/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from 'vs/nls';
import * as resources from 'vs/base/common/resources';
import * as objects from 'vs/base/common/objects';
import { IFileService, IFileStat, FileKind } from 'vs/platform/files/common/files';
import { IQuickInputService, IQuickPickItem, IQuickPick } from 'vs/platform/quickinput/common/quickInput';
import { URI } from 'vs/base/common/uri';
import { isWindows } from 'vs/base/common/platform';
import { ISaveDialogOptions, IOpenDialogOptions, IFileDialogService } from 'vs/platform/dialogs/common/dialogs';
import { REMOTE_HOST_SCHEME } from 'vs/platform/remote/common/remoteHosts';
import { ILabelService } from 'vs/platform/label/common/label';
import { IWorkspaceContextService } from 'vs/platform/workspace/common/workspace';
import { INotificationService } from 'vs/platform/notification/common/notification';
import { IModelService } from 'vs/editor/common/services/modelService';
import { IModeService } from 'vs/editor/common/services/modeService';
import { getIconClasses } from 'vs/editor/common/services/getIconClasses';
import { Schemas } from 'vs/base/common/network';
import { IWorkbenchEnvironmentService } from 'vs/workbench/services/environment/common/environmentService';
import { IRemoteAgentService } from 'vs/workbench/services/remote/common/remoteAgentService';
import { IContextKeyService, IContextKey } from 'vs/platform/contextkey/common/contextkey';
import { RemoteFileDialogContext } from 'vs/workbench/common/contextkeys';
import { equalsIgnoreCase, format } from 'vs/base/common/strings';
import { OpenLocalFileAction, OpenLocalFileFolderAction, OpenLocalFolderAction } from 'vs/workbench/browser/actions/workspaceActions';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';

interface FileQuickPickItem extends IQuickPickItem {
	uri: URI;
	isFolder: boolean;
}

enum UpdateResult {
	Updated,
	NotUpdated,
	InvalidPath
}

// Reference: https://en.wikipedia.org/wiki/Filename
const INVALID_FILE_CHARS = isWindows ? /[\\/:\*\?"<>\|]/g : /[\\/]/g;
const WINDOWS_FORBIDDEN_NAMES = /^(con|prn|aux|clock\$|nul|lpt[0-9]|com[0-9])$/i;

export class RemoteFileDialog {
	private options: IOpenDialogOptions;
	private currentFolder: URI;
	private filePickBox: IQuickPick<FileQuickPickItem>;
	private hidden: boolean;
	private allowFileSelection: boolean;
	private allowFolderSelection: boolean;
	private remoteAuthority: string | undefined;
	private requiresTrailing: boolean;
	private scheme: string = REMOTE_HOST_SCHEME;
	private shouldOverwriteFile: boolean = false;
	private contextKey: IContextKey<boolean>;
	private userEnteredPathSegment: string;
	private autoCompletePathSegment: string;
	private activeItem: FileQuickPickItem;
	private userHome: URI;
	private badPath: string | undefined;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@ILabelService private readonly labelService: ILabelService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@INotificationService private readonly notificationService: INotificationService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IModelService private readonly modelService: IModelService,
		@IModeService private readonly modeService: IModeService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@IRemoteAgentService private readonly remoteAgentService: IRemoteAgentService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		this.remoteAuthority = this.environmentService.configuration.remoteAuthority;
		this.contextKey = RemoteFileDialogContext.bindTo(contextKeyService);
	}

	public async showOpenDialog(options: IOpenDialogOptions = {}): Promise<URI[] | undefined> {
		this.scheme = this.getScheme(options.defaultUri, options.availableFileSystems);
		this.userHome = await this.getUserHome();
		const newOptions = await this.getOptions(options);
		if (!newOptions) {
			return Promise.resolve(undefined);
		}
		this.options = newOptions;
		return this.pickResource();
	}

	public async showSaveDialog(options: ISaveDialogOptions): Promise<URI | undefined> {
		this.scheme = this.getScheme(options.defaultUri, options.availableFileSystems);
		this.userHome = await this.getUserHome();
		this.requiresTrailing = true;
		const newOptions = await this.getOptions(options, true);
		if (!newOptions) {
			return Promise.resolve(undefined);
		}
		this.options = newOptions;
		this.options.canSelectFolders = true;
		this.options.canSelectFiles = true;

		return new Promise<URI | undefined>((resolve) => {
			this.pickResource(true).then(folderUri => {
				resolve(folderUri ? folderUri[0] : undefined);
			});
		});
	}

	private getOptions(options: ISaveDialogOptions | IOpenDialogOptions, isSave: boolean = false): IOpenDialogOptions | undefined {
		let defaultUri = options.defaultUri;
		const filename = (defaultUri && isSave && (resources.dirname(defaultUri).path === '/')) ? resources.basename(defaultUri) : undefined;
		if (!defaultUri || filename) {
			defaultUri = this.userHome;
			if (filename) {
				defaultUri = resources.joinPath(defaultUri, filename);
			}
		}
		if ((this.scheme !== Schemas.file) && !this.fileService.canHandleResource(defaultUri)) {
			this.notificationService.info(nls.localize('remoteFileDialog.notConnectedToRemote', 'File system provider for {0} is not available.', defaultUri.toString()));
			return undefined;
		}
		const newOptions: IOpenDialogOptions = objects.deepClone(options);
		newOptions.defaultUri = defaultUri;
		return newOptions;
	}

	private remoteUriFrom(path: string): URI {
		path = path.replace(/\\/g, '/');
		return resources.toLocalResource(URI.from({ scheme: this.scheme, path }), this.scheme === Schemas.file ? undefined : this.remoteAuthority);
	}

	private getScheme(defaultUri: URI | undefined, available: string[] | undefined): string {
		return defaultUri ? defaultUri.scheme : (available ? available[0] : Schemas.file);
	}

	private async getUserHome(): Promise<URI> {
		if (this.scheme !== Schemas.file) {
			const env = await this.remoteAgentService.getEnvironment();
			if (env) {
				return env.userHome;
			}
		}
		return URI.from({ scheme: this.scheme, path: this.environmentService.userHome });
	}

	private async pickResource(isSave: boolean = false): Promise<URI[] | undefined> {
		this.allowFolderSelection = !!this.options.canSelectFolders;
		this.allowFileSelection = !!this.options.canSelectFiles;
		this.hidden = false;
		let homedir: URI = this.options.defaultUri ? this.options.defaultUri : this.workspaceContextService.getWorkspace().folders[0].uri;
		let trailing: string | undefined;
		let stat: IFileStat | undefined;
		let ext: string = resources.extname(homedir);
		if (this.options.defaultUri) {
			try {
				stat = await this.fileService.resolve(this.options.defaultUri);
			} catch (e) {
				// The file or folder doesn't exist
			}
			if (!stat || !stat.isDirectory) {
				homedir = resources.dirname(this.options.defaultUri);
				trailing = resources.basename(this.options.defaultUri);
			}
			// append extension
			if (isSave && !ext && this.options.filters) {
				for (let i = 0; i < this.options.filters.length; i++) {
					if (this.options.filters[i].extensions[0] !== '*') {
						ext = '.' + this.options.filters[i].extensions[0];
						trailing = trailing ? trailing + ext : ext;
						break;
					}
				}
			}
		}

		return new Promise<URI[] | undefined>(async (resolve) => {
			this.filePickBox = this.quickInputService.createQuickPick<FileQuickPickItem>();
			this.filePickBox.matchOnLabel = false;
			this.filePickBox.autoFocusOnList = false;
			this.filePickBox.ok = true;
			if (this.options && this.options.availableFileSystems && (this.options.availableFileSystems.length > 1)) {
				this.filePickBox.customButton = true;
				this.filePickBox.customLabel = nls.localize('remoteFileDialog.local', 'Show Local');
				const action = this.allowFileSelection ? (this.allowFolderSelection ? OpenLocalFileFolderAction : OpenLocalFileAction) : OpenLocalFolderAction;
				const keybinding = this.keybindingService.lookupKeybinding(action.ID);
				if (keybinding) {
					const label = keybinding.getLabel();
					if (label) {
						this.filePickBox.customHover = format('{0} ({1})', action.LABEL, label);
					}
				}
			}

			let isResolving = false;
			let isAcceptHandled = false;
			this.currentFolder = homedir;
			this.userEnteredPathSegment = '';
			this.autoCompletePathSegment = '';
			// this.filePickBox.canSelectMany = true;
			this.filePickBox.title = this.options.title;
			this.filePickBox.value = this.pathFromUri(this.currentFolder, true);
			this.filePickBox.valueSelection = [this.filePickBox.value.length, this.filePickBox.value.length];
			this.filePickBox.items = [];

			function doResolve(dialog: RemoteFileDialog, uri: URI[] | undefined) {
				resolve(uri);
				dialog.contextKey.set(false);
				dialog.filePickBox.dispose();
			}

			this.filePickBox.onDidCustom(() => {
				if (isAcceptHandled || this.filePickBox.busy) {
					return;
				}

				isAcceptHandled = true;
				isResolving = true;
				if (this.options.availableFileSystems && (this.options.availableFileSystems.length > 1)) {
					this.options.availableFileSystems.shift();
				}
				this.options.defaultUri = undefined;
				if (this.requiresTrailing) {
					return this.fileDialogService.showSaveDialog(this.options).then(result => {
						doResolve(this, result ? [result] : undefined);
					});
				} else {
					return this.fileDialogService.showOpenDialog(this.options).then(result => {
						doResolve(this, result);
					});
				}
			});

			this.filePickBox.onDidAccept(_ => {
				if (isAcceptHandled || this.filePickBox.busy) {
					return;
				}

				isAcceptHandled = true;
				isResolving = true;
				this.onDidAccept().then(resolveValue => {
					if (resolveValue) {
						this.filePickBox.hide();
						doResolve(this, resolveValue);
					} else if (this.hidden) {
						doResolve(this, undefined);
					} else {
						isResolving = false;
						isAcceptHandled = false;
					}
				});
			});
			this.filePickBox.onDidChangeActive(i => {
				isAcceptHandled = false;
				// update input box to match the first selected item
				if (this.isChangeFromUser()) {
					this.filePickBox.validationMessage = undefined;
					if (i.length === 1) {
						this.setAutoComplete(this.constructFullUserPath(), this.userEnteredPathSegment, i[0], true);
					} else {
						this.setAutoComplete(this.constructFullUserPath(), '', undefined);
					}
				}
			});
			this.filePickBox.onDidChangeSelection(i => {
				this.setAutoComplete(this.constructFullUserPath(), '', undefined);
			});

			this.filePickBox.onDidChangeValue(async value => {
				// onDidChangeValue can also be triggered by the auto complete, so if it looks like the auto complete, don't do anything
				if (this.isChangeFromUser()) {
					// If the user has just entered more bad path, don't change anything
					if (value !== this.constructFullUserPath() && !this.isBadSubpath(value)) {
						this.filePickBox.validationMessage = undefined;
						this.shouldOverwriteFile = false;
						const valueUri = this.remoteUriFrom(this.trimTrailingSlash(this.filePickBox.value));
						let updated: UpdateResult = UpdateResult.NotUpdated;
						if (!resources.isEqual(this.remoteUriFrom(this.trimTrailingSlash(this.pathFromUri(this.currentFolder))), valueUri, true)) {
							updated = await this.tryUpdateItems(value, this.remoteUriFrom(this.filePickBox.value));
						}
						if (updated === UpdateResult.NotUpdated) {
							this.setActiveItems(value);
						}
					} else {
						this.filePickBox.activeItems = [];
					}
				}
			});
			this.filePickBox.onDidHide(() => {
				this.hidden = true;
				if (!isResolving) {
					doResolve(this, undefined);
				}
			});

			this.filePickBox.show();
			this.contextKey.set(true);
			await this.updateItems(homedir, trailing);
			if (trailing) {
				this.filePickBox.valueSelection = [this.filePickBox.value.length - trailing.length, this.filePickBox.value.length - ext.length];
			} else {
				this.filePickBox.valueSelection = [this.filePickBox.value.length, this.filePickBox.value.length];
			}
		});
	}

	private isBadSubpath(value: string) {
		return this.badPath && (value.length > this.badPath.length) && equalsIgnoreCase(value.substring(0, this.badPath.length), this.badPath);
	}

	private isChangeFromUser(): boolean {
		if ((this.filePickBox.value === this.pathAppend(this.currentFolder, this.userEnteredPathSegment + this.autoCompletePathSegment))
			&& (this.activeItem === (this.filePickBox.activeItems ? this.filePickBox.activeItems[0] : undefined))) {
			return false;
		}
		return true;
	}

	private constructFullUserPath(): string {
		return this.pathAppend(this.currentFolder, this.userEnteredPathSegment);
	}

	private async onDidAccept(): Promise<URI[] | undefined> {
		let resolveValue: URI[] | undefined;
		let navigateValue: URI | undefined;
		const trimmedPickBoxValue = ((this.filePickBox.value.length > 1) && this.endsWithSlash(this.filePickBox.value)) ? this.filePickBox.value.substr(0, this.filePickBox.value.length - 1) : this.filePickBox.value;
		const inputUri = this.remoteUriFrom(trimmedPickBoxValue);
		const inputUriDirname = resources.dirname(inputUri);
		let stat: IFileStat | undefined;
		let statDirname: IFileStat | undefined;
		try {
			statDirname = await this.fileService.resolve(inputUriDirname);
			stat = await this.fileService.resolve(inputUri);
		} catch (e) {
			// do nothing
		}

		// Find resolve value
		if (this.filePickBox.selectedItems && this.filePickBox.selectedItems.length > 0) {
			resolveValue = [];
			this.filePickBox.selectedItems.forEach(selectedItem => {
				resolveValue!.push(selectedItem.uri);
			});
		} else if (this.filePickBox.activeItems.length === 0) {
			if (!this.requiresTrailing && resources.isEqual(this.currentFolder, inputUri, true)) {
				resolveValue = [inputUri];
			} else if (statDirname && statDirname.isDirectory) {
				resolveValue = [inputUri];
			} else if (stat && stat.isDirectory) {
				navigateValue = inputUri;
			}
		} else if (this.filePickBox.activeItems.length === 1) {
			const item = this.filePickBox.selectedItems[0];
			if (item) {
				if (!item.isFolder) {
					resolveValue = [item.uri];
				} else {
					navigateValue = item.uri;
				}
			}
		}

		if (resolveValue) {
			if (resolveValue.length === 1) {
				resolveValue[0] = this.addPostfix(resolveValue[0]);
			}
			if (await this.validate(resolveValue)) {
				return Promise.resolve(resolveValue);
			}
		} else if (navigateValue) {
			// Try to navigate into the folder
			await this.updateItems(navigateValue);
		} else {
			// validation error. Path does not exist.
		}
		return Promise.resolve(undefined);
	}

	private async tryUpdateItems(value: string, valueUri: URI): Promise<UpdateResult> {
		if (value[value.length - 1] === '~') {
			await this.updateItems(this.userHome);
			this.badPath = undefined;
			return UpdateResult.Updated;
		} else if (this.endsWithSlash(value) || (!resources.isEqual(this.currentFolder, resources.dirname(valueUri), true) && resources.isEqualOrParent(this.currentFolder, resources.dirname(valueUri), true))) {
			let stat: IFileStat | undefined;
			try {
				stat = await this.fileService.resolve(valueUri);
			} catch (e) {
				// do nothing
			}
			if (stat && stat.isDirectory && (resources.basename(valueUri) !== '.') && this.endsWithSlash(value)) {
				await this.updateItems(valueUri);
				return UpdateResult.Updated;
			} else if (this.endsWithSlash(value)) {
				// The input box contains a path that doesn't exist on the system.
				this.filePickBox.validationMessage = nls.localize('remoteFileDialog.badPath', 'The path does not exist.');
				// Save this bad path. It can take too long to to a stat on every user entered character, but once a user enters a bad path they are likely
				// to keep typing more bad path. We can compare against this bad path and see if the user entered path starts with it.
				this.badPath = value;
				return UpdateResult.InvalidPath;
			} else {
				const inputUriDirname = resources.dirname(valueUri);
				if (!resources.isEqual(this.remoteUriFrom(this.trimTrailingSlash(this.pathFromUri(this.currentFolder))), inputUriDirname, true)) {
					let statWithoutTrailing: IFileStat | undefined;
					try {
						statWithoutTrailing = await this.fileService.resolve(inputUriDirname);
					} catch (e) {
						// do nothing
					}
					if (statWithoutTrailing && statWithoutTrailing.isDirectory && (resources.basename(valueUri) !== '.')) {
						await this.updateItems(inputUriDirname, resources.basename(valueUri));
						this.badPath = undefined;
						return UpdateResult.Updated;
					}
				}
			}
		}
		this.badPath = undefined;
		return UpdateResult.NotUpdated;
	}

	private setActiveItems(value: string) {
		const inputBasename = resources.basename(this.remoteUriFrom(value));
		// Make sure that the folder whose children we are currently viewing matches the path in the input
		const userPath = this.constructFullUserPath();
		if (userPath === value.substring(0, userPath.length)) {
			let hasMatch = false;
			for (let i = 0; i < this.filePickBox.items.length; i++) {
				const item = <FileQuickPickItem>this.filePickBox.items[i];
				if (this.setAutoComplete(value, inputBasename, item)) {
					hasMatch = true;
					break;
				}
			}
			if (!hasMatch) {
				this.userEnteredPathSegment = inputBasename;
				this.autoCompletePathSegment = '';
				this.filePickBox.activeItems = [];
			}
		} else {
			if (inputBasename !== resources.basename(this.currentFolder)) {
				this.userEnteredPathSegment = inputBasename;
			} else {
				this.userEnteredPathSegment = '';
			}
			this.autoCompletePathSegment = '';
		}
	}

	private setAutoComplete(startingValue: string, startingBasename: string, quickPickItem: FileQuickPickItem | undefined, force: boolean = false): boolean {
		if (!quickPickItem) {
			this.autoCompletePathSegment = '';
			this.userEnteredPathSegment = '';
			this.filePickBox.valueSelection = [startingValue.length, this.filePickBox.value.length];
			this.insertText(startingValue, '');
			return false;
		} else if (this.filePickBox.busy) {
			// We're in the middle of something else. Doing an auto complete now can result jumbled or incorrect autocompletes.
			this.userEnteredPathSegment = startingBasename;
			this.autoCompletePathSegment = '';
			return false;
		}
		const itemBasename = quickPickItem.label;
		// Either force the autocomplete, or the old value should be one smaller than the new value and match the new value.
		if (!force && (itemBasename.length >= startingBasename.length) && equalsIgnoreCase(itemBasename.substr(0, startingBasename.length), startingBasename)) {
			this.userEnteredPathSegment = startingBasename;
			this.activeItem = quickPickItem;
			// Changing the active items will trigger the onDidActiveItemsChanged. Clear the autocomplete first, then set it after.
			this.autoCompletePathSegment = '';
			this.filePickBox.activeItems = [quickPickItem];
			this.autoCompletePathSegment = itemBasename.substr(startingBasename.length);
			this.insertText(startingValue + this.autoCompletePathSegment, this.autoCompletePathSegment);
			this.filePickBox.valueSelection = [startingValue.length, this.filePickBox.value.length];
			return true;
		} else if (force && (quickPickItem.label !== (this.userEnteredPathSegment + this.autoCompletePathSegment))) {
			this.userEnteredPathSegment = '';
			this.autoCompletePathSegment = itemBasename;
			this.activeItem = quickPickItem;
			this.filePickBox.valueSelection = [this.pathFromUri(this.currentFolder, true).length, this.filePickBox.value.length];
			// use insert text to preserve undo buffer
			this.insertText(this.pathAppend(this.currentFolder, itemBasename), itemBasename);
			this.filePickBox.valueSelection = [this.filePickBox.value.length - itemBasename.length, this.filePickBox.value.length];
			return true;
		} else {
			this.userEnteredPathSegment = startingBasename;
			this.autoCompletePathSegment = '';
			return false;
		}
	}

	private insertText(wholeValue: string, insertText: string) {
		if (this.filePickBox.inputHasFocus()) {
			document.execCommand('insertText', false, insertText);
		} else {
			this.filePickBox.value = wholeValue;
		}
	}

	private addPostfix(uri: URI): URI {
		let result = uri;
		if (this.requiresTrailing && this.options.filters && this.options.filters.length > 0) {
			// Make sure that the suffix is added. If the user deleted it, we automatically add it here
			let hasExt: boolean = false;
			const currentExt = resources.extname(uri).substr(1);
			if (currentExt !== '') {
				for (let i = 0; i < this.options.filters.length; i++) {
					for (let j = 0; j < this.options.filters[i].extensions.length; j++) {
						if ((this.options.filters[i].extensions[j] === '*') || (this.options.filters[i].extensions[j] === currentExt)) {
							hasExt = true;
							break;
						}
					}
					if (hasExt) {
						break;
					}
				}
			}
			if (!hasExt) {
				result = resources.joinPath(resources.dirname(uri), resources.basename(uri) + '.' + this.options.filters[0].extensions[0]);
			}
		}
		return result;
	}

	private trimTrailingSlash(path: string): string {
		return ((path.length > 1) && this.endsWithSlash(path)) ? path.substr(0, path.length - 1) : path;
	}

	private yesNoPrompt(message: string): Promise<boolean> {
		interface YesNoItem extends IQuickPickItem {
			value: boolean;
		}
		const prompt = this.quickInputService.createQuickPick<YesNoItem>();
		const no = nls.localize('remoteFileDialog.no', 'No');
		prompt.items = [{ label: no, value: false }, { label: nls.localize('remoteFileDialog.yes', 'Yes'), value: true }];
		prompt.title = message;
		prompt.placeholder = no;
		let isResolving = false;
		return new Promise<boolean>(resolve => {
			prompt.onDidAccept(() => {
				isResolving = true;
				prompt.hide();
				resolve(prompt.selectedItems ? prompt.selectedItems[0].value : false);
			});
			prompt.onDidHide(() => {
				if (!isResolving) {
					resolve(false);
				}
				this.filePickBox.show();
				this.hidden = false;
				this.filePickBox.items = this.filePickBox.items;
				prompt.dispose();
			});
			prompt.show();
		});
	}

	private async validate(uri: URI[]): Promise<boolean> {
		for (let i = 0; i < uri.length; i++) {
			let stat: IFileStat | undefined;
			let statDirname: IFileStat | undefined;
			try {
				statDirname = await this.fileService.resolve(resources.dirname(uri[i]));
				stat = await this.fileService.resolve(uri[i]);
			} catch (e) {
				// do nothing
			}

			if (this.requiresTrailing) { // save
				if (uri.length > 1) {
					// The uri array can only have one value in it. Something has gone very wrong otherwise.
					this.filePickBox.validationMessage = nls.localize('remoteFileDialog.tooMany', 'Can only Save As one item.');
					return Promise.resolve(false);
				} else if (stat && stat.isDirectory) {
					// Can't do this
					this.filePickBox.validationMessage = nls.localize('remoteFileDialog.validateFolder', 'The folder already exists. Please use a new file name.');
					return Promise.resolve(false);
				} else if (stat && !this.shouldOverwriteFile) {
					// Replacing a file.
					this.shouldOverwriteFile = true;
					// Show a yes/no prompt
					const message = nls.localize('remoteFileDialog.validateExisting', '{0} already exists. Are you sure you want to overwrite it?', resources.basename(uri[i]));
					return this.yesNoPrompt(message);
				} else if (!this.isValidBaseName(resources.basename(uri[i]))) {
					// Filename not allowed
					this.filePickBox.validationMessage = nls.localize('remoteFileDialog.validateBadFilename', 'Please enter a valid file name.');
					return Promise.resolve(false);
				} else if (!statDirname || !statDirname.isDirectory) {
					// Folder to save in doesn't exist
					this.filePickBox.validationMessage = nls.localize('remoteFileDialog.validateNonexistentDir', 'Please enter a path that exists.');
					return Promise.resolve(false);
				}
			} else { // open
				if (!stat) {
					// File or folder doesn't exist
					this.filePickBox.validationMessage = nls.localize('remoteFileDialog.validateNonexistentDir', 'Please enter a path that exists.');
					return Promise.resolve(false);
				} else if (stat.isDirectory && !this.allowFolderSelection) {
					// Folder selected when folder selection not permitted
					this.filePickBox.validationMessage = nls.localize('remoteFileDialog.validateFileOnly', 'Please select a file.');
					return Promise.resolve(false);
				} else if (!stat.isDirectory && !this.allowFileSelection) {
					// File selected when file selection not permitted
					this.filePickBox.validationMessage = nls.localize('remoteFileDialog.validateFolderOnly', 'Please select a folder.');
					return Promise.resolve(false);
				}
			}
		}
		return Promise.resolve(true);
	}

	private async updateItems(newFolder: URI, trailing?: string) {
		this.filePickBox.busy = true;
		this.userEnteredPathSegment = trailing ? trailing : '';
		this.autoCompletePathSegment = '';
		const newValue = trailing ? this.pathFromUri(resources.joinPath(newFolder, trailing)) : this.pathFromUri(newFolder, true);
		this.currentFolder = this.remoteUriFrom(this.pathFromUri(newFolder, true));
		return this.createItems(this.currentFolder).then(items => {
			this.filePickBox.items = items;
			if (this.allowFolderSelection) {
				this.filePickBox.activeItems = [];
			}
			if (!equalsIgnoreCase(this.filePickBox.value, newValue)) {
				this.filePickBox.valueSelection = [0, this.filePickBox.value.length];
				this.insertText(newValue, newValue);
			}
			this.filePickBox.valueSelection = [this.filePickBox.value.length, this.filePickBox.value.length];
			this.filePickBox.busy = false;
		});
	}

	private pathFromUri(uri: URI, endWithSeparator: boolean = false): string {
		const sep = this.labelService.getSeparator(uri.scheme, uri.authority);
		let result: string;
		if (sep === '/') {
			result = uri.fsPath.replace(/\\/g, sep);
		} else {
			result = uri.fsPath.replace(/\//g, sep);
		}
		if (endWithSeparator && !this.endsWithSlash(result)) {
			result = result + sep;
		}
		return result;
	}

	private pathAppend(uri: URI, additional: string): string {
		if ((additional === '..') || (additional === '.')) {
			const basePath = this.pathFromUri(uri);
			return basePath + (this.endsWithSlash(basePath) ? '' : this.labelService.getSeparator(uri.scheme, uri.authority)) + additional;
		} else {
			return this.pathFromUri(resources.joinPath(uri, additional));
		}
	}

	private isValidBaseName(name: string): boolean {
		if (!name || name.length === 0 || /^\s+$/.test(name)) {
			return false; // require a name that is not just whitespace
		}

		INVALID_FILE_CHARS.lastIndex = 0; // the holy grail of software development
		if (INVALID_FILE_CHARS.test(name)) {
			return false; // check for certain invalid file characters
		}

		if (isWindows && WINDOWS_FORBIDDEN_NAMES.test(name)) {
			return false; // check for certain invalid file names
		}

		if (name === '.' || name === '..') {
			return false; // check for reserved values
		}

		if (isWindows && name[name.length - 1] === '.') {
			return false; // Windows: file cannot end with a "."
		}

		if (isWindows && name.length !== name.trim().length) {
			return false; // Windows: file cannot end with a whitespace
		}

		return true;
	}

	private endsWithSlash(s: string) {
		return /[\/\\]$/.test(s);
	}

	private basenameWithTrailingSlash(fullPath: URI): string {
		const child = this.pathFromUri(fullPath, true);
		const parent = this.pathFromUri(resources.dirname(fullPath), true);
		return child.substring(parent.length);
	}

	private createBackItem(currFolder: URI): FileQuickPickItem | null {
		const parentFolder = resources.dirname(currFolder)!;
		if (!resources.isEqual(currFolder, parentFolder, true)) {
			return { label: '..', uri: resources.dirname(currFolder), isFolder: true };
		}
		return null;
	}

	private async createItems(currentFolder: URI): Promise<FileQuickPickItem[]> {
		const result: FileQuickPickItem[] = [];

		const backDir = this.createBackItem(currentFolder);
		try {
			const folder = await this.fileService.resolve(currentFolder);
			const fileNames = folder.children ? folder.children.map(child => child.name) : [];
			const items = await Promise.all(fileNames.map(fileName => this.createItem(fileName, currentFolder)));
			for (let item of items) {
				if (item) {
					result.push(item);
				}
			}
		} catch (e) {
			// ignore
			console.log(e);
		}
		const sorted = result.sort((i1, i2) => {
			if (i1.isFolder !== i2.isFolder) {
				return i1.isFolder ? -1 : 1;
			}
			const trimmed1 = this.endsWithSlash(i1.label) ? i1.label.substr(0, i1.label.length - 1) : i1.label;
			const trimmed2 = this.endsWithSlash(i2.label) ? i2.label.substr(0, i2.label.length - 1) : i2.label;
			return trimmed1.localeCompare(trimmed2);
		});

		if (backDir) {
			sorted.unshift(backDir);
		}
		return sorted;
	}

	private filterFile(file: URI): boolean {
		if (this.options.filters) {
			const ext = resources.extname(file);
			for (let i = 0; i < this.options.filters.length; i++) {
				for (let j = 0; j < this.options.filters[i].extensions.length; j++) {
					if (ext === ('.' + this.options.filters[i].extensions[j])) {
						return true;
					}
				}
			}
			return false;
		}
		return true;
	}

	private async createItem(filename: string, parent: URI): Promise<FileQuickPickItem | undefined> {
		let fullPath = resources.joinPath(parent, filename);
		try {
			const stat = await this.fileService.resolve(fullPath);
			if (stat.isDirectory) {
				filename = this.basenameWithTrailingSlash(fullPath);
				return { label: filename, uri: fullPath, isFolder: true, iconClasses: getIconClasses(this.modelService, this.modeService, fullPath || undefined, FileKind.FOLDER) };
			} else if (!stat.isDirectory && this.allowFileSelection && this.filterFile(fullPath)) {
				return { label: filename, uri: fullPath, isFolder: false, iconClasses: getIconClasses(this.modelService, this.modeService, fullPath || undefined) };
			}
			return undefined;
		} catch (e) {
			return undefined;
		}
	}
}