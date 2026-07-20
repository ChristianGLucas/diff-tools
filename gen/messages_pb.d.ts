// package: christiangeorgelucas.diff_tools
// file: messages.proto

import * as jspb from "google-protobuf";

export class Hunk extends jspb.Message {
  getOldStart(): number;
  setOldStart(value: number): void;

  getOldLines(): number;
  setOldLines(value: number): void;

  getNewStart(): number;
  setNewStart(value: number): void;

  getNewLines(): number;
  setNewLines(value: number): void;

  clearLinesList(): void;
  getLinesList(): Array<string>;
  setLinesList(value: Array<string>): void;
  addLines(value: string, index?: number): string;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): Hunk.AsObject;
  static toObject(includeInstance: boolean, msg: Hunk): Hunk.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: Hunk, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): Hunk;
  static deserializeBinaryFromReader(message: Hunk, reader: jspb.BinaryReader): Hunk;
}

export namespace Hunk {
  export type AsObject = {
    oldStart: number,
    oldLines: number,
    newStart: number,
    newLines: number,
    linesList: Array<string>,
  }
}

export class Patch extends jspb.Message {
  getUnifiedDiff(): string;
  setUnifiedDiff(value: string): void;

  clearHunksList(): void;
  getHunksList(): Array<Hunk>;
  setHunksList(value: Array<Hunk>): void;
  addHunks(value?: Hunk, index?: number): Hunk;

  getOriginalName(): string;
  setOriginalName(value: string): void;

  getRevisedName(): string;
  setRevisedName(value: string): void;

  getIdentical(): boolean;
  setIdentical(value: boolean): void;

  getError(): string;
  setError(value: string): void;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): Patch.AsObject;
  static toObject(includeInstance: boolean, msg: Patch): Patch.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: Patch, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): Patch;
  static deserializeBinaryFromReader(message: Patch, reader: jspb.BinaryReader): Patch;
}

export namespace Patch {
  export type AsObject = {
    unifiedDiff: string,
    hunksList: Array<Hunk.AsObject>,
    originalName: string,
    revisedName: string,
    identical: boolean,
    error: string,
  }
}

export class Texts extends jspb.Message {
  getOriginal(): string;
  setOriginal(value: string): void;

  getRevised(): string;
  setRevised(value: string): void;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): Texts.AsObject;
  static toObject(includeInstance: boolean, msg: Texts): Texts.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: Texts, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): Texts;
  static deserializeBinaryFromReader(message: Texts, reader: jspb.BinaryReader): Texts;
}

export namespace Texts {
  export type AsObject = {
    original: string,
    revised: string,
  }
}

export class TextPair extends jspb.Message {
  getOriginal(): string;
  setOriginal(value: string): void;

  getRevised(): string;
  setRevised(value: string): void;

  getOriginalName(): string;
  setOriginalName(value: string): void;

  getRevisedName(): string;
  setRevisedName(value: string): void;

  getContextLines(): number;
  setContextLines(value: number): void;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): TextPair.AsObject;
  static toObject(includeInstance: boolean, msg: TextPair): TextPair.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: TextPair, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): TextPair;
  static deserializeBinaryFromReader(message: TextPair, reader: jspb.BinaryReader): TextPair;
}

export namespace TextPair {
  export type AsObject = {
    original: string,
    revised: string,
    originalName: string,
    revisedName: string,
    contextLines: number,
  }
}

export class UnifiedDiffText extends jspb.Message {
  getUnifiedDiff(): string;
  setUnifiedDiff(value: string): void;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): UnifiedDiffText.AsObject;
  static toObject(includeInstance: boolean, msg: UnifiedDiffText): UnifiedDiffText.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: UnifiedDiffText, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): UnifiedDiffText;
  static deserializeBinaryFromReader(message: UnifiedDiffText, reader: jspb.BinaryReader): UnifiedDiffText;
}

export namespace UnifiedDiffText {
  export type AsObject = {
    unifiedDiff: string,
  }
}

export class PatchApplyRequest extends jspb.Message {
  getOriginal(): string;
  setOriginal(value: string): void;

  hasPatch(): boolean;
  clearPatch(): void;
  getPatch(): Patch | undefined;
  setPatch(value?: Patch): void;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): PatchApplyRequest.AsObject;
  static toObject(includeInstance: boolean, msg: PatchApplyRequest): PatchApplyRequest.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: PatchApplyRequest, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): PatchApplyRequest;
  static deserializeBinaryFromReader(message: PatchApplyRequest, reader: jspb.BinaryReader): PatchApplyRequest;
}

export namespace PatchApplyRequest {
  export type AsObject = {
    original: string,
    patch?: Patch.AsObject,
  }
}

export class PatchApplyResult extends jspb.Message {
  getText(): string;
  setText(value: string): void;

  getApplied(): boolean;
  setApplied(value: boolean): void;

  getError(): string;
  setError(value: string): void;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): PatchApplyResult.AsObject;
  static toObject(includeInstance: boolean, msg: PatchApplyResult): PatchApplyResult.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: PatchApplyResult, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): PatchApplyResult;
  static deserializeBinaryFromReader(message: PatchApplyResult, reader: jspb.BinaryReader): PatchApplyResult;
}

export namespace PatchApplyResult {
  export type AsObject = {
    text: string,
    applied: boolean,
    error: string,
  }
}

export class SimilarityScore extends jspb.Message {
  getRatio(): number;
  setRatio(value: number): void;

  getMatchingLines(): number;
  setMatchingLines(value: number): void;

  getOriginalLines(): number;
  setOriginalLines(value: number): void;

  getRevisedLines(): number;
  setRevisedLines(value: number): void;

  getError(): string;
  setError(value: string): void;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): SimilarityScore.AsObject;
  static toObject(includeInstance: boolean, msg: SimilarityScore): SimilarityScore.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: SimilarityScore, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): SimilarityScore;
  static deserializeBinaryFromReader(message: SimilarityScore, reader: jspb.BinaryReader): SimilarityScore;
}

export namespace SimilarityScore {
  export type AsObject = {
    ratio: number,
    matchingLines: number,
    originalLines: number,
    revisedLines: number,
    error: string,
  }
}

export class DiffStats extends jspb.Message {
  getLinesAdded(): number;
  setLinesAdded(value: number): void;

  getLinesDeleted(): number;
  setLinesDeleted(value: number): void;

  getChangedBlocks(): number;
  setChangedBlocks(value: number): void;

  getOriginalLines(): number;
  setOriginalLines(value: number): void;

  getRevisedLines(): number;
  setRevisedLines(value: number): void;

  getIdentical(): boolean;
  setIdentical(value: boolean): void;

  getError(): string;
  setError(value: string): void;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): DiffStats.AsObject;
  static toObject(includeInstance: boolean, msg: DiffStats): DiffStats.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: DiffStats, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): DiffStats;
  static deserializeBinaryFromReader(message: DiffStats, reader: jspb.BinaryReader): DiffStats;
}

export namespace DiffStats {
  export type AsObject = {
    linesAdded: number,
    linesDeleted: number,
    changedBlocks: number,
    originalLines: number,
    revisedLines: number,
    identical: boolean,
    error: string,
  }
}

