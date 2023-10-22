import { app, shell } from 'electron';
import fs from 'fs';
import path from 'path';

import { IWindowsApplication } from '../shared/application-types';
import log from '../shared/logging';
import {
  ArrayValue,
  DOS_HEADER,
  DWORD,
  IMAGE_DATA_DIRECTORY,
  IMAGE_DIRECTORY_ENTRY_IMPORT,
  IMAGE_DIRECTORY_ENTRY_RESOURCE,
  IMAGE_FILE_HEADER,
  IMAGE_IMPORT_MODULE_DIRECTORY,
  IMAGE_NT_HEADERS,
  IMAGE_NT_HEADERS64,
  IMAGE_OPTIONAL_HEADER32,
  IMAGE_RESOURCE_DIRECTORY,
  IMAGE_RESOURCE_DIRECTORY_DATA_ENTRY,
  IMAGE_RESOURCE_DIRECTORY_ID_ENTRY,
  ImageNtHeadersUnion,
  ImageOptionalHeaderUnion,
  PrimitiveValue,
  rvaToOffset as rvaToOffsetImpl,
  STRING_FILE_INFO,
  STRING_TABLE,
  STRING_TABLE_STRING,
  StructValue,
  StructWrapper,
  Value,
  VS_VERSIONINFO,
} from './windows-pe-parser';

interface ShortcutDetails {
  target: string;
  name: string;
  args?: string;
  deletable: boolean;
}

type RvaToOffset = (rva: number) => Promise<number>;

// Applications are found by scanning the start menu directories
const APPLICATION_PATHS = [
  `${process.env.ProgramData}/Microsoft/Windows/Start Menu/Programs`,
  `${process.env.AppData}/Microsoft/Windows/Start Menu/Programs`,
];

// Some applications might be falsely filtered from the application list. This allow-list specifies
// apps that are falsely filtered but should be included.
const APPLICATION_ALLOW_LIST = [
  'firefox.exe',
  'chrome.exe',
  'msedge.exe',
  'brave.exe',
  'iexplore.exe',
];

// Cache of all previously scanned shortcuts.
const shortcutCache: Record<string, ShortcutDetails> = {};
// Cache of all previously scanned applications.
const applicationCache: Record<string, IWindowsApplication> = {};
// List of shortcuts that have been added manually by the user.
let additionalShortcuts: ShortcutDetails[] = [];

// Finds applications by searching through the startmenu for shortcuts with and exe-file as target.
// If applicationPaths has a value, the returned applications are only the ones corresponding to
// those paths.
export async function getApplications(options: {
  applicationPaths?: string[];
  updateCaches?: boolean;
}): Promise<{ fromCache: boolean; applications: IWindowsApplication[] }> {
  const cacheIsEmpty = Object.keys(shortcutCache).length === 0;

  if (options.updateCaches || cacheIsEmpty) {
    await updateShortcutCache();
  }

  // Add excluded apps that are missing from the shortcut cache to it
  if (options.applicationPaths) {
    await Promise.all(options.applicationPaths.map(addApplicationToAdditionalShortcuts));
  }

  await updateApplicationCache();
  // If applicationPaths is supplied the returnvalue should only contain the applications
  // corresponding to those paths.
  const applications = Object.values(applicationCache)
    .filter(
      (application) =>
        options.applicationPaths === undefined ||
        options.applicationPaths.find(
          (applicationPath) =>
            applicationPath.toLowerCase() === application.absolutepath.toLowerCase(),
        ) !== undefined,
    )
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    fromCache: !options.updateCaches && !cacheIsEmpty,
    applications,
  };
}

// Adds either a shortcut or an executable to the additionalShortcuts list
export async function addApplicationPathToCache(applicationPath: string): Promise<string> {
  const parsedPath = path.parse(applicationPath);
  if (parsedPath.ext === '.lnk') {
    const shortcutDetiails = shell.readShortcutLink(path.resolve(applicationPath));
    additionalShortcuts.push({
      ...shortcutDetiails,
      name: path.parse(applicationPath).name,
      deletable: true,
    });
    return shortcutDetiails.target;
  } else {
    await addApplicationToAdditionalShortcuts(applicationPath);
    return applicationPath;
  }
}

export function removeApplicationFromCache(application: IWindowsApplication): void {
  additionalShortcuts = additionalShortcuts.filter(
    (shortcut) => shortcut.target !== application.absolutepath,
  );
  delete applicationCache[application.absolutepath.toLowerCase()];
}

// Reads the start-menu directories and adds all shortcuts, targeting applications using networking,
// to the shortcuts cache. Whether or not an application use networking is determined by checking for
// "WS2_32.dll" in it's imports.
async function updateShortcutCache(): Promise<void> {
  const links = await Promise.all(APPLICATION_PATHS.map(findAllLinks));
  const resolvedLinks = removeDuplicates(resolveLinks(links.flat()));

  const shortcuts: ShortcutDetails[] = [];
  for (const shortcut of resolvedLinks) {
    if (
      APPLICATION_ALLOW_LIST.includes(path.basename(shortcut.target.toLowerCase())) ||
      (await importsDll(shortcut.target, 'WS2_32.dll'))
    ) {
      shortcuts.push(shortcut);
      shortcutCache[shortcut.target.toLowerCase()] = shortcut;
    }
  }
}

async function updateApplicationCache(): Promise<void> {
  const shortcuts = Object.values(shortcutCache).concat(additionalShortcuts);

  await Promise.all(
    shortcuts.map(async (shortcut) => {
      const lowercaseTarget = shortcut.target.toLowerCase();
      if (applicationCache[lowercaseTarget] === undefined) {
        applicationCache[lowercaseTarget] = await convertToSplitTunnelingApplication(shortcut);
      }

      return applicationCache[lowercaseTarget];
    }),
  );
}

// Add excluded apps that are missing from the shortcut cache to it
async function addApplicationToAdditionalShortcuts(applicationPath: string): Promise<void> {
  if (
    shortcutCache[applicationPath.toLowerCase()] === undefined &&
    !additionalShortcuts.some(
      (shortcut) => shortcut.target.toLowerCase() === applicationPath.toLowerCase(),
    )
  ) {
    additionalShortcuts.push({
      target: applicationPath,
      name: (await getProgramName(applicationPath)) ?? path.parse(applicationPath).name,
      deletable: true,
    });
  }
}

// Fins all links in a directory.
async function findAllLinks(path: string): Promise<string[]> {
  if (path.endsWith('.lnk')) {
    return [path];
  } else {
    const stat = await fs.promises.stat(path);
    if (stat.isDirectory()) {
      const contents = await fs.promises.readdir(path);
      const result = await Promise.all(contents.map((item) => findAllLinks(`${path}/${item}`)));
      return result.flat();
    } else {
      return [];
    }
  }
}

function resolveLinks(linkPaths: string[]): ShortcutDetails[] {
  return linkPaths
    .map((link) => {
      try {
        return {
          ...shell.readShortcutLink(path.resolve(link)),
          name: path.parse(link).name,
        };
      } catch {
        return null;
      }
    })
    .filter(
      (shortcut): shortcut is ShortcutDetails =>
        shortcut !== null &&
        !shortcut.target.endsWith('Mullvad VPN.exe') &&
        shortcut.target.endsWith('.exe') &&
        !shortcut.target.toLowerCase().includes('install') && // Covers "uninstall" as well.
        !shortcut.name.toLowerCase().includes('install'),
    );
}

async function getProgramName(exePath: string): Promise<string | undefined> {
  try {
    return await getProductName(exePath);
  } catch {
    return undefined;
  }
}

// Removes all duplicate shortcuts.
function removeDuplicates(shortcuts: ShortcutDetails[]): ShortcutDetails[] {
  const unique = shortcuts.reduce((shortcuts, shortcut) => {
    const lowercaseTarget = shortcut.target.toLowerCase();
    if (shortcuts[lowercaseTarget]) {
      if (
        shortcuts[lowercaseTarget].args &&
        shortcuts[lowercaseTarget].args !== '' &&
        (!shortcut.args || shortcut.args === '')
      ) {
        shortcuts[lowercaseTarget] = shortcut;
      }
    } else {
      shortcuts[lowercaseTarget] = shortcut;
    }
    return shortcuts;
  }, {} as Record<string, ShortcutDetails>);

  return Object.values(unique);
}

async function convertToSplitTunnelingApplication(
  shortcut: ShortcutDetails,
): Promise<IWindowsApplication> {
  return {
    absolutepath: shortcut.target,
    name: shortcut.name,
    icon: await retrieveIcon(shortcut.target),
    deletable: shortcut.deletable,
  };
}

async function retrieveIcon(exe: string) {
  const icon = await app.getFileIcon(exe, { size: 'large' });
  return icon.toDataURL();
}

// Checks if the application at the supplied path imports a specific dll.
async function importsDll(path: string, dllName: string): Promise<boolean> {
  let fileHandle: fs.promises.FileHandle;
  try {
    fileHandle = await fs.promises.open(path, fs.constants.O_RDONLY);
  } catch (e) {
    return false;
  }

  const imports = await getExeImports(fileHandle, path);
  await fileHandle.close();
  return imports.map((name) => name.toLowerCase()).includes(dllName.toLowerCase());
}

async function getExeImports(fileHandle: fs.promises.FileHandle, path: string): Promise<string[]> {
  try {
    const tableOffsetResult = await getTableOffset(fileHandle, IMAGE_DIRECTORY_ENTRY_IMPORT);
    if (tableOffsetResult) {
      const { offset: importTableOffset, rvaToOffset } = tableOffsetResult;
      const moduleNames = await getImportModuleNames(fileHandle, importTableOffset, rvaToOffset);
      return moduleNames;
    } else {
      return [];
    }
  } catch (e) {
    log.error(`Failed to read .exe import table for ${path}.`, e);
    return [];
  }
}

async function readString(
  fileHandle: fs.promises.FileHandle,
  offset: number,
  encoding: 'ascii' | 'ucs2',
): Promise<{ value: string; endOffset: number }> {
  const characterSize = getCharacterSize(encoding);
  const buffer = Buffer.alloc(characterSize);
  await fileHandle.read(buffer, 0, characterSize, offset);

  const nextOffset = offset + characterSize;
  if (buffer.every((value) => value === 0)) {
    return { value: '', endOffset: nextOffset };
  } else {
    const { value: nextValue, endOffset } = await readString(fileHandle, nextOffset, encoding);
    const value = buffer.toString(encoding) + nextValue;
    return { value, endOffset };
  }
}

function getCharacterSize(encoding: 'ascii' | 'ucs2'): number {
  switch (encoding) {
    case 'ascii':
      return 1;
    case 'ucs2':
      return 2;
  }
}

// Finds and returns the NT header.
async function getNtHeader(
  fileHandle: fs.promises.FileHandle,
): Promise<StructValue<ImageNtHeadersUnion>> {
  // Check whether or not the file follows the PE format.
  const dosHeader = await Value.fromFile(fileHandle, 0, DOS_HEADER);
  const eMagic = dosHeader.get<PrimitiveValue>('e_magic').value();
  if (eMagic !== 0x5a4d) {
    throw new Error('Not a PE file');
  }

  const ntHeaderOffset = dosHeader.get<PrimitiveValue>('e_lfanew').value();

  // Check if this is a 32- or 64-bit exe-file and return the correct datatype.
  const ntHeader32 = await Value.fromFile(fileHandle, ntHeaderOffset, IMAGE_NT_HEADERS);
  const signature = ntHeader32.get<PrimitiveValue>('Signature').buffer.toString('ascii');
  if (signature !== 'PE\0\0') {
    throw new Error('Not a PE file');
  }

  const magic = ntHeader32
    .get<StructValue<typeof IMAGE_OPTIONAL_HEADER32>>('OptionalHeader')
    .get<PrimitiveValue>('Magic')
    .value();

  // magic is 0x20b for 64-bit executables.
  return magic === 0x20b
    ? Value.fromFile(fileHandle, ntHeaderOffset, IMAGE_NT_HEADERS64)
    : ntHeader32;
}

// Reads the import table and returns a list of the imported DLLs.
async function getImportModuleNames(
  fileHandle: fs.promises.FileHandle,
  importTableOffset: number,
  rvaToOffset: RvaToOffset,
): Promise<string[]> {
  const moduleNames: string[] = [];
  const entrySize = Value.sizeOf(IMAGE_IMPORT_MODULE_DIRECTORY);

  // eslint-disable-next-line no-constant-condition
  for (let i = 0; true; i++) {
    const importEntry = await Value.fromFile(
      fileHandle,
      importTableOffset + i * entrySize,
      IMAGE_IMPORT_MODULE_DIRECTORY,
    );
    const nameRva = importEntry.get('ModuleName').value();

    if (nameRva !== 0x0) {
      const offset = await rvaToOffset(nameRva);

      const { value: name } = await readString(fileHandle, offset, 'ascii');
      moduleNames.push(name);
    } else {
      return moduleNames;
    }
  }
}

async function getProductName(path: string): Promise<string | undefined> {
  let fileHandle: fs.promises.FileHandle;
  try {
    fileHandle = await fs.promises.open(path, fs.constants.O_RDONLY);
  } catch {
    return undefined;
  }

  try {
    const getTableOffsetResult = await getTableOffset(fileHandle, IMAGE_DIRECTORY_ENTRY_RESOURCE);

    if (getTableOffsetResult) {
      const { offset: resourceTableOffset, rvaToOffset } = getTableOffsetResult;
      const leafOffsets = await getResourceTreeLeafOffsets(
        fileHandle,
        resourceTableOffset,
        resourceTableOffset,
        rvaToOffset,
        [[16], [1], [0, 1033]],
      );

      const productName = await leafOffsets.reduce(async (alreadyFoundValue, leafOffset) => {
        const value = await alreadyFoundValue;
        if (value) {
          return value;
        } else {
          const strings = await getVsVersionInfoStrings(fileHandle, leafOffset);
          return strings.get('FileDescription') ?? strings.get('ProductName');
        }
      }, Promise.resolve() as Promise<string | undefined>);

      return productName;
    } else {
      return undefined;
    }
  } catch {
    return undefined;
  } finally {
    await fileHandle.close();
  }
}

async function getTableOffset(
  fileHandle: fs.promises.FileHandle,
  tableIndex: number,
): Promise<{ offset: number; rvaToOffset: RvaToOffset } | undefined> {
  const ntHeader = await getNtHeader(fileHandle);
  const fileHeader = ntHeader.get<StructValue<typeof IMAGE_FILE_HEADER>>('FileHeader');
  const optionalHeader = ntHeader.get<StructValue<ImageOptionalHeaderUnion>>('OptionalHeader');

  const tableRva = optionalHeader
    .get<ArrayValue<typeof IMAGE_DATA_DIRECTORY>>('DataDirectory')
    .nth(tableIndex)
    .get('VirtualAddress')
    .value();

  if (tableRva === 0x0) {
    return undefined;
  }

  const numberOfSections = fileHeader.get<PrimitiveValue>('NumberOfSections').value();
  const ntHeaderEndOffset =
    ntHeader.offset +
    ntHeader.get<PrimitiveValue<typeof DWORD>>('Signature').size +
    fileHeader.size +
    fileHeader.get<PrimitiveValue>('SizeOfOptionalHeader').value();

  const rvaToOffset = (rva: number) =>
    rvaToOffsetImpl(fileHandle, rva, numberOfSections, ntHeaderEndOffset);

  const tableOffset = await rvaToOffset(tableRva);

  return { offset: tableOffset, rvaToOffset };
}

// Searches the resource tree for the supplied paths and returns the leaves at the end of those
// paths.
async function getResourceTreeLeafOffsets(
  fileHandle: fs.promises.FileHandle,
  sectionOffset: number,
  tableOffset: number,
  rvaToOffset: (rva: number) => Promise<number>,
  [ids, ...path]: number[][],
): Promise<number[]> {
  const table = await Value.fromFile(fileHandle, tableOffset, IMAGE_RESOURCE_DIRECTORY);

  const numberOfNameEntries = table.get('NumberOfNameEntries').value();
  const numberOfIdEntries = table.get('NumberOfIdEntries').value();

  const leaves: number[] = [];

  for (let i = numberOfNameEntries; i < numberOfNameEntries + numberOfIdEntries; i++) {
    const offset =
      tableOffset +
      Value.sizeOf(IMAGE_RESOURCE_DIRECTORY) +
      i * Value.sizeOf(IMAGE_RESOURCE_DIRECTORY_ID_ENTRY);
    const entry = await Value.fromFile(fileHandle, offset, IMAGE_RESOURCE_DIRECTORY_ID_ENTRY);

    const id = entry.get('Id').value();
    if (!ids.includes(id)) {
      continue;
    }

    let offsetToData = entry.get('OffsetToData').value();
    // If the first bit is 1 then the offset points to another node, otherwise it point to a leaf.
    const isLeaf = (offsetToData & 0x80000000) === 0;

    if (isLeaf && path.length === 0) {
      const leafDataOffset = await getResourceTreeLeafValueOffset(
        fileHandle,
        sectionOffset + offsetToData,
        rvaToOffset,
      );

      leaves.push(leafDataOffset);
    } else if (!isLeaf) {
      offsetToData &= 0x7fffffff;

      const subTreeLeaves = await getResourceTreeLeafOffsets(
        fileHandle,
        sectionOffset,
        sectionOffset + offsetToData,
        rvaToOffset,
        path,
      );

      leaves.push(...subTreeLeaves);
    } else {
      continue;
    }
  }

  return leaves;
}

// Finds the Strings structures within the VS_VERSIONINFO structure and returns the contents.
async function getVsVersionInfoStrings(
  fileHandle: fs.promises.FileHandle,
  offset: number,
): Promise<Map<string, string>> {
  try {
    const stringFileInfoOffset = await getVsVersionInfoChildrenOffset(fileHandle, offset);

    const stringTableOffset = await getChildrenOffset(
      fileHandle,
      stringFileInfoOffset,
      STRING_FILE_INFO,
      (szKey) => szKey === 'StringFileInfo',
    );
    const stringTable = await Value.fromFile(fileHandle, stringTableOffset, STRING_TABLE);
    const stringTableLength = stringTable.get<PrimitiveValue>('wLength').value();

    const stringsOffset = await getChildrenOffset(
      fileHandle,
      stringTableOffset,
      STRING_TABLE,
      (szKey) => szKey.substr(4).toLowerCase() === '04b0',
    );

    const strings = await parseStrings(
      fileHandle,
      stringsOffset,
      stringTableOffset + stringTableLength,
    );

    return strings;
  } catch {
    return new Map();
  }
}

// Loops through the list of strings and returns a map with the contents.
async function parseStrings(
  fileHandle: fs.promises.FileHandle,
  stringsOffset: number,
  stringTableEnd: number,
): Promise<Map<string, string>> {
  const strings = new Map<string, string>();

  let currentStringOffset = stringsOffset;
  while (currentStringOffset < stringTableEnd) {
    const stringValue = await Value.fromFile(fileHandle, currentStringOffset, STRING_TABLE_STRING);
    const structSize = stringValue.get('wLength').value();
    const valueSize = (stringValue.get('wValueLength').value() - 1) * 2;

    const szKeyOffset = currentStringOffset + stringValue.size;
    const { value: szKey, endOffset } = await readString(fileHandle, szKeyOffset, 'ucs2');

    const valueOffset = alignDword(endOffset);
    // Some programs specify the value size in bytes instead of words resulting in reading double
    // the length. To make sure we don't read beyond the end offset we calculate the max size to
    // read. The last value is the null termination character.
    const calculatedValueMaxSize = structSize - (valueOffset - currentStringOffset) - 2;
    const valueReadSize = Math.min(valueSize, calculatedValueMaxSize);

    const { buffer } = await fileHandle.read(
      Buffer.alloc(valueReadSize),
      0,
      valueReadSize,
      valueOffset,
    );
    const value = buffer.toString('ucs2');

    strings.set(szKey, value);
    currentStringOffset += alignDword(stringValue.get<PrimitiveValue>('wLength').value());
  }

  return strings;
}

async function getResourceTreeLeafValueOffset(
  fileHandle: fs.promises.FileHandle,
  offset: number,
  rvaToOffset: (rva: number) => Promise<number>,
): Promise<number> {
  const leaf = await Value.fromFile(fileHandle, offset, IMAGE_RESOURCE_DIRECTORY_DATA_ENTRY);
  const valueRva = leaf.get<PrimitiveValue>('DataRVA').value();
  const valueOffset = await rvaToOffset(valueRva);

  return valueOffset;
}

// Finds the offset to the Children field in the VS_VERSIONINFO structure.
async function getVsVersionInfoChildrenOffset(fileHandle: fs.promises.FileHandle, offset: number) {
  const valueValueOffset = await getChildrenOffset(
    fileHandle,
    offset,
    VS_VERSIONINFO,
    (szKey) => szKey === 'VS_VERSION_INFO',
  );
  const versionInfo = await Value.fromFile(fileHandle, offset, VS_VERSIONINFO);
  const versionInfoValueLength = versionInfo.get<PrimitiveValue>('wValueLength').value();
  const valuePadding2Offset = valueValueOffset + versionInfoValueLength;
  const valueChildrenOffset = alignDword(valuePadding2Offset);

  return valueChildrenOffset;
}

// Finds the offset to the Children field in any of the STRING_FILE_INFO, STRING_TABLE and
// STRING_TABLE_STRING structures.
async function getChildrenOffset(
  fileHandle: fs.promises.FileHandle,
  offset: number,
  datatype: StructWrapper,
  validateSzKey?: (szKey: string) => boolean,
) {
  const szKeyOffset = offset + Value.sizeOf(datatype);
  const { value, endOffset } = await readString(fileHandle, szKeyOffset, 'ucs2');
  if (validateSzKey && !validateSzKey(value)) {
    throw new Error(`Invalid szKey "${value}"`);
  }

  return alignDword(endOffset);
}

function alignDword(offset: number): number {
  return Math.ceil(offset / 4) * 4;
}
