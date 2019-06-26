/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import {
    Browser,
    ConnectionState,
    FileMode,
    IBlob,
    IBlobManager,
    IChunkedOp,
    IContainerContext,
    IDeltaManager,
    IDocumentMessage,
    IDocumentStorageService,
    ILoader,
    IQuorum,
    IRequest,
    IResponse,
    ISequencedDocumentMessage,
    ISignalMessage,
    ISnapshotTree,
    ISummaryBlob,
    ISummaryTree,
    ITelemetryLogger,
    ITree,
    MessageType,
    SummaryObject,
    SummaryTree,
    SummaryType,
    TreeEntry,
} from "@prague/container-definitions";
import {
    IAttachMessage,
    IComponentFactory,
    IComponentRuntime,
    IEnvelope,
    IHelpMessage,
    IHostRuntime,
    IInboundSignalMessage,
} from "@prague/runtime-definitions";
import { buildHierarchy, Deferred, flatten, isSystemType, readAndParse } from "@prague/utils";
import * as assert from "assert";
import { EventEmitter } from "events";
import { ComponentContext } from "./componentContext";
import { ComponentStorageService } from "./componentStorageService";
import { debug } from "./debug";
import { LeaderElector } from "./leaderElection";
import { Summarizer } from "./summarizer";
import { SummaryManager } from "./summaryManager";
import { analyzeTasks } from "./taskAnalyzer";

export interface IComponentRegistry {
    get(name: string): Promise<IComponentFactory>;
}

interface IBufferedChunk {
    type: MessageType;

    content: string;
}

// Consider idle 5s of no activity. And snapshot if a minute has gone by with no snapshot.
const IdleDetectionTime = 5000;
const MaxTimeWithoutSnapshot = IdleDetectionTime * 12;
// Snapshot if 1000 ops received since last snapshot.
const MaxOpCountWithoutSnapshot = 1000;

export interface IContainerRuntimeOptions {
    // Experimental flag that will generate summaries if connected to a service that supports them.
    // Will eventually become the default and snapshots will be deprecated
    generateSummaries: boolean;
}

// Context will define the component level mappings
export class ContainerRuntime extends EventEmitter implements IHostRuntime {
    public static async load(
        context: IContainerContext,
        registry: IComponentRegistry,
        runtimeOptions?: IContainerRuntimeOptions,
    ): Promise<ContainerRuntime> {
        const runtime = new ContainerRuntime(context, registry, runtimeOptions);

        const components = new Map<string, ISnapshotTree>();
        if (context.baseSnapshot.trees[".protocol"]) {
            Object.keys(context.baseSnapshot.trees).forEach((value) => {
                if (value !== ".protocol") {
                    const tree = context.baseSnapshot.trees[value];
                    components.set(value, tree);
                }
            });
        } else {
            const snapshotTreesP = Object.keys(context.baseSnapshot.commits).map(async (key) => {
                const moduleId = context.baseSnapshot.commits[key];
                const commit = (await context.storage.getVersions(moduleId, 1))[0];
                const moduleTree = await context.storage.getSnapshotTree(commit);
                return { id: key, tree: moduleTree };
            });

            const snapshotTree = await Promise.all(snapshotTreesP);
            for (const value of snapshotTree) {
                components.set(value.id, value.tree);
            }
        }

        const componentsP = new Array<Promise<void>>();
        for (const [componentId, snapshot] of components) {
            const componentP = runtime.loadComponent(componentId, snapshot, context.blobs);
            componentsP.push(componentP);
        }

        async function getChunks() {
            const chunkId = context.baseSnapshot.blobs[".chunks"];
            if (!chunkId) {
                return;
            }

            const chunks = await readAndParse<Array<[string, string[]]>>(context.storage, chunkId);
            for (const chunk of chunks) {
                runtime.chunkMap.set(chunk[0], chunk[1]);
            }
        }
        const chunksP = getChunks();

        await Promise.all([...componentsP, chunksP]);

        return runtime;
    }

    public get connectionState(): ConnectionState {
        return this.context.connectionState;
    }

    public get id(): string {
        return this.context.id;
    }

    public get parentBranch(): string {
        return this.context.parentBranch;
    }

    public get existing(): boolean {
        return this.context.existing;
    }

    // tslint:disable-next-line:no-unsafe-any
    public get options(): any {
        return this.context.options;
    }

    public get clientId(): string {
        return this.context.clientId;
    }

    public get clientType(): string {
        return this.context.clientType;
    }

    public get blobManager(): IBlobManager {
        return this.context.blobManager;
    }

    public get deltaManager(): IDeltaManager<ISequencedDocumentMessage, IDocumentMessage> {
        return this.context.deltaManager;
    }

    public get storage(): IDocumentStorageService {
        return this.context.storage;
    }

    public get branch(): string {
        return this.context.branch;
    }

    public get minimumSequenceNumber(): number {
        return this.context.minimumSequenceNumber;
    }

    public get submitFn(): (type: MessageType, contents: any) => number {
        return this.submit;
    }

    public get submitSignalFn(): (contents: any) => void {
        return this.context.submitSignalFn;
    }

    public get snapshotFn(): (message: string) => Promise<void> {
        return this.context.snapshotFn;
    }

    public get closeFn(): () => void {
        return this.context.closeFn;
    }

    public get loader(): ILoader {
        return this.context.loader;
    }

    public readonly logger: ITelemetryLogger;
    public readonly summaryManager: SummaryManager;

    private tasks: string[] = [];
    private leaderElector: LeaderElector;

    // back-compat: version decides between loading document and chaincode.
    private version: string;

    public get connected(): boolean {
        return this.connectionState === ConnectionState.Connected;
    }

    public get leader(): boolean {
        return this.leaderElector && (this.leaderElector.getLeader() === this.clientId);
    }

    // Components tracked by the Domain
    private readonly componentContexts = new Map<string, ComponentContext>();
    private readonly componentContextsDeferred = new Map<string, Deferred<ComponentContext>>();
    private closed = false;
    private readonly pendingAttach = new Map<string, IAttachMessage>();
    private requestHandler: (request: IRequest) => Promise<IResponse>;
    private lastMinSequenceNumber: number;
    private dirtyDocument = false;
    private readonly summarizer: Summarizer;

    // Local copy of incomplete received chunks.
    private readonly chunkMap = new Map<string, string[]>();

     // Local copy of sent but unacknowledged chunks.
    private readonly unackedChunkedMessages: Map<number, IBufferedChunk> = new Map<number, IBufferedChunk>();

    private constructor(
        private readonly context: IContainerContext,
        private readonly registry: IComponentRegistry,
        private readonly runtimeOptions: IContainerRuntimeOptions = { generateSummaries: false },
    ) {
        super();
        this.logger = context.logger;
        this.lastMinSequenceNumber = context.minimumSequenceNumber;
        this.startLeaderElection();

        this.deltaManager.on("allSentOpsAckd", () => {
            assert(this.connected);
            this.updateDocumentDirtyState(false);
        });

        this.deltaManager.on("submitOp", (message: IDocumentMessage) => {
            assert(this.connected);
            if (!isSystemType(message.type) && message.type !== MessageType.NoOp) {
                this.updateDocumentDirtyState(true);
            }
        });

        this.context.quorum.on("removeMember", (clientId: string) => {
            this.clearPartialChunks(clientId);
        });

        // We always create the summarizer in the case that we are asked to generate summaries. But this may
        // want to be on demand instead.
        this.summarizer = new Summarizer(
            "/_summarizer",
            this,
            IdleDetectionTime,
            MaxTimeWithoutSnapshot,
            MaxOpCountWithoutSnapshot,
            () => this.generateSummary());

        // Create the SummaryManager and mark the initial state
        this.summaryManager = new SummaryManager(context, this.runtimeOptions.generateSummaries);
        if (this.context.connectionState === ConnectionState.Connected) {
            // TODO can remove in 0.6 - legacy drivers may be missing version
            if (this.context.deltaManager.version  && this.context.deltaManager.version.indexOf("^0.2") === 0) {
                this.summaryManager.setConnected(this.context.clientId);
            }
        }
    }

    public async loadComponent(
        id: string,
        snapshotTree: ISnapshotTree,
        extraBlobs: Map<string, string>,
    ): Promise<void> {
        // Need to rip through snapshot and use that to populate extraBlobs
        const runtimeStorage = new ComponentStorageService(this.storage, extraBlobs);
        const details = await readAndParse<{ pkg: string }>(this.storage, snapshotTree.blobs[".component"]);

        // Create and store the unstarted component
        const component = new ComponentContext(
            this,
            details.pkg,
            id,
            true,
            runtimeStorage,
            snapshotTree);
        this.componentContexts.set(id, component);

        // Create a promise that will resolve to the started component
        const deferred = new Deferred<ComponentContext>();
        this.componentContextsDeferred.set(id, deferred);

        await component.start();

        deferred.resolve(component);
    }

    public registerRequestHandler(handler: (request: IRequest) => Promise<IResponse>) {
        this.requestHandler = handler;
    }

    public getPackage(name: string): Promise<IComponentFactory> {
        return this.registry.get(name);
    }

    public async request(request: IRequest): Promise<IResponse> {
        // system routes
        if (request.url === this.summarizer.url) {
            return { status: 200, mimeType: "prague/component", value: this.summarizer };
        }

        // If no app specified handler has been specified then this is a 404
        if (!this.requestHandler) {
            return { status: 404, mimeType: "text/plain", value: `${request.url} not found` };
        }

        // Otherwise we defer to the app to handle the requset
        return this.requestHandler(request);
    }

    /**
     * Returns a summary of the runtime at the current sequence number
     */
    public async summarize(): Promise<ISummaryTree> {
        const result: ISummaryTree = {
            tree: {},
            type: SummaryType.Tree,
        };

        // Iterate over each component and ask it to snapshot
        const componentEntries = new Map<string, ITree>();
        this.componentContexts.forEach((component, key) => componentEntries.set(key, component.snapshot()));

        for (const [componentId, componentSnapshot] of componentEntries) {
            if (componentSnapshot.id) {
                result.tree[componentId] = {
                    handle: componentSnapshot.id,
                    handleType: SummaryType.Tree,
                    type: SummaryType.Handle,
                };
            } else {
                const tree = this.convertToSummaryTree(componentSnapshot);
                result.tree[componentId] = tree;
            }
        }

        if (this.chunkMap.size > 0) {
            result.tree[".chunks"] = {
                content: JSON.stringify([...this.chunkMap]),
                type: SummaryType.Blob,
            };
        }

        return result;
    }

    public async snapshot(tagMessage: string): Promise<ITree> {
        // Pull in the prior version and snapshot tree to store against
        const lastVersion = await this.storage.getVersions(this.id, 1);
        const tree = lastVersion.length > 0
            ? await this.storage.getSnapshotTree(lastVersion[0])
            : { blobs: {}, commits: {}, trees: {} };

        // Iterate over each component and ask it to snapshot
        const componentEntries = new Map<string, ITree>();
        this.componentContexts.forEach((component, key) => componentEntries.set(key, component.snapshot()));

        // Use base tree to know previous component snapshot and then snapshot each component
        const componentVersionsP = new Array<Promise<{ id: string, version: string }>>();
        for (const [componentId, componentSnapshot] of componentEntries) {
            // If ID exists then previous commit is still valid
            if (componentSnapshot.id) {
                componentVersionsP.push(Promise.resolve({
                    id: componentId,
                    version: tree.commits[componentId],
                }));
            } else {
                const parent = componentId in tree.commits ? [tree.commits[componentId]] : [];
                const componentVersionP = this.storage
                    .write(componentSnapshot, parent, `${componentId} commit ${tagMessage}`, componentId)
                    .then((version) => {
                        this.componentContexts.get(componentId).updateBaseId(version.treeId);
                        return { id: componentId, version: version.id };
                    });
                componentVersionsP.push(componentVersionP);
            }
        }

        const root: ITree = { entries: [], id: null };

        // Add in module references to the component snapshots
        const componentVersions = await Promise.all(componentVersionsP);
        let gitModules = "";
        for (const componentVersion of componentVersions) {
            root.entries.push({
                mode: FileMode.Commit,
                path: componentVersion.id,
                type: TreeEntry[TreeEntry.Commit],
                value: componentVersion.version,
            });

            const repoUrl = "https://github.com/kurtb/praguedocs.git"; // this.storageService.repositoryUrl
            // tslint:disable-next-line: max-line-length
            gitModules += `[submodule "${componentVersion.id}"]\n\tpath = ${componentVersion.id}\n\turl = ${repoUrl}\n\n`;
        }

        if (this.chunkMap.size > 0) {
            root.entries.push({
                mode: FileMode.File,
                path: ".chunks",
                type: TreeEntry[TreeEntry.Blob],
                value: {
                    contents: JSON.stringify([...this.chunkMap]),
                    encoding: "utf-8",
                },
            });
        }

        // Write the module lookup details
        root.entries.push({
            mode: FileMode.File,
            path: ".gitmodules",
            type: TreeEntry[TreeEntry.Blob],
            value: {
                contents: gitModules,
                encoding: "utf-8",
            },
        });

        return root;
    }

    public async requestSnapshot(tagMessage: string): Promise<void> {
        return this.context.requestSnapshot(tagMessage);
    }

    public async stop(): Promise<void> {
        this.verifyNotClosed();
        this.closed = true;
    }

    public changeConnectionState(value: ConnectionState, clientId: string, version: string) {
        this.verifyNotClosed();

        assert(this.connectionState === value);

        if (value === ConnectionState.Connected) {
            // Resend all pending attach messages prior to notifying clients
            for (const [, message] of this.pendingAttach) {
                this.submit(MessageType.Attach, message);
            }

            // Also send any unacked chunk messages
            this.sendUnackedChunks();
        }

        for (const [, componentContext] of this.componentContexts) {
            componentContext.changeConnectionState(value, clientId);
        }

        if (value === ConnectionState.Connected) {
            this.emit("connected", this.clientId);

            // TODO can remove in 0.6 - legacy drivers may be missing version
            if (version && version.indexOf("^0.2") === 0) {
                this.summaryManager.setConnected(clientId);
            }
        } else {
            this.emit("disconnected");
            this.summaryManager.setDisconnected();
        }
    }

    public prepare(message: ISequencedDocumentMessage, local: boolean): Promise<any> {
        switch (message.type) {
            case MessageType.Operation:
                return this.prepareOperation(message, local);

            case MessageType.Attach:
                return this.prepareAttach(message, local);

            case MessageType.ChunkedOp:
                const chunkComplete = this.prepareRemoteChunkedMessage(message);
                if (!chunkComplete) {
                    return Promise.resolve();
                } else {
                    if (local) {
                        const clientSeqNumber = message.clientSequenceNumber;
                        if (this.unackedChunkedMessages.has(clientSeqNumber)) {
                            this.unackedChunkedMessages.delete(clientSeqNumber);
                        }
                    }

                    return this.prepare(message, local);
                }

            default:
                return Promise.resolve();
        }
    }

    public process(message: ISequencedDocumentMessage, local: boolean, context: any) {
        switch (message.type) {
            case MessageType.Operation:
                this.processOperation(message, local, context);
                break;

            case MessageType.Attach:
                this.processAttach(message, local, context as ComponentContext);
                break;

            default:
        }

        this.emit("op", message);

        if (this.lastMinSequenceNumber !== message.minimumSequenceNumber) {
            this.lastMinSequenceNumber = message.minimumSequenceNumber;
            this.updateMinSequenceNumber(message.minimumSequenceNumber);
        }
    }

    public async postProcess(message: ISequencedDocumentMessage, local: boolean, context: any) {
        switch (message.type) {
            case MessageType.Attach:
                return this.postProcessAttach(message, local, context as ComponentContext);
            default:
        }
    }

    public processSignal(message: ISignalMessage, local: boolean) {
        const envelope = message.content as IEnvelope;
        const component = this.componentContexts.get(envelope.address);
        assert(component);
        const innerContent = envelope.contents as { content: any, type: string };

        const transformed: IInboundSignalMessage = {
            clientId: message.clientId,
            content: innerContent.content,
            type: innerContent.type,
        };
        component.processSignal(transformed, local);
    }

    public async getComponentRuntime(id: string, wait = true): Promise<IComponentRuntime> {
        this.verifyNotClosed();

        if (!this.componentContextsDeferred.has(id)) {
            if (!wait) {
                return Promise.reject(`Process ${id} does not exist`);
            }

            // Add in a deferred that will resolve once the process ID arrives
            this.componentContextsDeferred.set(id, new Deferred<ComponentContext>());
        }

        const componentContext = await this.componentContextsDeferred.get(id).promise;
        return componentContext.componentRuntime;
    }

    public async createAndAttachComponent(id: string, pkg: string): Promise<IComponentRuntime> {
        this.verifyNotClosed();

        const runtimeStorage = new ComponentStorageService(this.storage, new Map());
        const componentContext = new ComponentContext(
            this,
            pkg,
            id,
            false,
            runtimeStorage,
            null);

        // Generate the attach message. This may include ownership
        const message: IAttachMessage = {
            id,
            snapshot: null,
            type: pkg,
        };
        this.pendingAttach.set(id, message);
        this.submit(MessageType.Attach, message);

        // Store off the component
        const deferred = new Deferred<ComponentContext>();
        this.componentContextsDeferred.set(id, deferred);
        this.componentContexts.set(id, componentContext);

        // Start the component
        const componentRuntime = await componentContext.start();
        deferred.resolve(componentContext);

        return componentRuntime;
    }

    public getQuorum(): IQuorum {
        return this.context.quorum;
    }

    public error(error: any) {
        this.context.error(error);
    }

    public registerTasks(tasks: string[], version?: string) {
        this.verifyNotClosed();
        this.tasks = tasks;
        this.version = version;
        if (this.leader) {
            this.runTaskAnalyzer();
        }
    }

    /* tslint:disable:no-unnecessary-override */
    public on(event: string | symbol, listener: (...args: any[]) => void): this {
        return super.on(event, listener);
    }

    /**
     * Called by IComponentRuntime (on behalf of distributed data structure) in disconnected state to notify about
     * local changes. All pending changes are automatically flushed by shared objects on connection.
     */
    public notifyPendingMessages(): void {
        assert(!this.connected);
        this.updateDocumentDirtyState(true);
    }

    /**
     * Returns true of document is dirty, i.e. there are some pending local changes that
     * either were not sent out to delta stream or were not yet acknowledged.
     */
    public isDocumentDirty(): boolean {
        return this.dirtyDocument;
    }

    private async generateSummary(): Promise<void> {
        const message =
            `Summary @${this.deltaManager.referenceSequenceNumber}:${this.deltaManager.minimumSequenceNumber}`;

        // TODO: Issue-2171 Support for Branch Snapshots
        if (this.parentBranch) {
            debug(`Skipping summary due to being branch of ${this.parentBranch}`);
            return;
        }

        if (!("uploadSummary" in this.context.storage)) {
            debug(`Driver does not support summary ops`);
            return;
        }

        try {
            await this.deltaManager.inbound.systemPause();

            // TODO in the future we can have stored the latest summary by listening to the summary ack message
            // after loading from the beginning of the snapshot
            const versions = await this.context.storage.getVersions(this.id, 1);
            const parents = versions.map((version) => version.id);
            const entries: { [path: string]: SummaryObject } = {};

            const componentEntries = await this.summarize();

            // And then combine
            const root: ISummaryTree = {
                tree: { ...entries, ...componentEntries.tree },
                type: SummaryType.Tree,
            };

            const handle = await this.context.storage.uploadSummary(root);
            const summary = {
                handle: handle.handle,
                head: parents[0],
                message,
                parents,
            };

            this.submit(MessageType.Summarize, summary);
        } catch (ex) {
            debug("Summary error", ex);
            throw ex;
        } finally {
            // Restart the delta manager
            await this.deltaManager.inbound.systemResume();
        }
    }

    private sendUnackedChunks() {
        for (const message of this.unackedChunkedMessages) {
            debug(`Resending unacked chunks!`);
            this.submitChunkedMessage(
                message[1].type,
                message[1].content,
                this.context.deltaManager.maxMessageSize);
        }
    }

    private prepareRemoteChunkedMessage(message: ISequencedDocumentMessage): boolean {
        const clientId = message.clientId;
        const chunkedContent = message.contents as IChunkedOp;
        this.addChunk(clientId, chunkedContent.contents);
        if (chunkedContent.chunkId === chunkedContent.totalChunks) {
            const serializedContent = this.chunkMap.get(clientId).join("");
            message.contents = JSON.parse(serializedContent);
            message.type = chunkedContent.originalType;
            this.clearPartialChunks(clientId);
            return true;
        }
        return false;
    }

    private addChunk(clientId: string, chunkedContent: string) {
        if (!this.chunkMap.has(clientId)) {
            this.chunkMap.set(clientId, []);
        }
        this.chunkMap.get(clientId).push(chunkedContent);
    }

    private clearPartialChunks(clientId: string) {
        if (this.chunkMap.has(clientId)) {
            this.chunkMap.delete(clientId);
        }
    }

    private updateDocumentDirtyState(dirty: boolean) {
        if (this.dirtyDocument === dirty) {
            return;
        }

        this.dirtyDocument = dirty;
        this.emit(dirty ? "dirtyDocument" : "savedDocument");
    }

    private convertToSummaryTree(snapshot: ITree): SummaryTree {
        if (snapshot.id) {
            return {
                handle: snapshot.id,
                handleType: SummaryType.Tree,
                type: SummaryType.Handle,
            };
        } else {
            const summaryTree: ISummaryTree = {
                tree: {},
                type: SummaryType.Tree,
            };

            for (const entry of snapshot.entries) {
                let value: SummaryObject;

                switch (entry.type) {
                    case TreeEntry[TreeEntry.Blob]:
                        const blob = entry.value as IBlob;
                        value = {
                            content: blob.encoding === "base64" ? Buffer.from(blob.contents, "base64") : blob.contents,
                            type: SummaryType.Blob,
                        } as ISummaryBlob;
                        break;

                    case TreeEntry[TreeEntry.Tree]:
                        value = this.convertToSummaryTree(entry.value as ITree);
                        break;

                    case TreeEntry[TreeEntry.Commit]:
                        value = this.convertToSummaryTree(entry.value as ITree);
                        break;

                    default:
                        throw new Error();
                }

                summaryTree.tree[entry.path] = value;
            }

            return summaryTree;
        }
    }

    private updateMinSequenceNumber(minimumSequenceNumber: number) {
        this.emit("minSequenceNumberChanged", this.deltaManager.minimumSequenceNumber);
    }

    private submit(type: MessageType, content: any): number {
        this.verifyNotClosed();

        const serializedContent = JSON.stringify(content);
        const maxOpSize = this.context.deltaManager.maxMessageSize;

        let clientSequenceNumber: number;

        // Note: Chunking will increase content beyond maxOpSize because we JSON'ing JSON payload -
        // there will be a lot of escape characters that can make it up to 2x bigger!
        // This is Ok, because DeltaManager.shouldSplit() will have 2 * maxMessageSize limit
        if (serializedContent.length <= maxOpSize) {
            clientSequenceNumber = this.context.submitFn(type, content);
        } else {
            clientSequenceNumber = this.submitChunkedMessage(type, serializedContent, maxOpSize);
            this.unackedChunkedMessages.set(clientSequenceNumber,
                {
                    content: serializedContent,
                    type,
                });
        }

        return clientSequenceNumber;
    }

    private submitChunkedMessage(type: MessageType, content: string, maxOpSize: number): number {
        const contentLength = content.length;
        const chunkN = Math.floor((contentLength - 1) / maxOpSize) + 1;
        let offset = 0;
        let clientSequenceNumber: number = 0;
        for (let i = 1; i <= chunkN; i = i + 1) {
            const chunkedOp: IChunkedOp = {
                chunkId: i,
                contents: content.substr(offset, maxOpSize),
                originalType: type,
                totalChunks: chunkN,
            };
            offset += maxOpSize;
            clientSequenceNumber = this.context.submitFn(MessageType.ChunkedOp, chunkedOp);
        }
        return clientSequenceNumber;
    }

    private verifyNotClosed() {
        if (this.closed) {
            throw new Error("Runtime is closed");
        }
    }

    private async prepareOperation(message: ISequencedDocumentMessage, local: boolean): Promise<any> {
        const envelope = message.contents as IEnvelope;
        const component = this.componentContexts.get(envelope.address);
        assert(component);
        const innerContents = envelope.contents as { content: any, type: string };

        const transformed: ISequencedDocumentMessage = {
            clientId: message.clientId,
            clientSequenceNumber: message.clientSequenceNumber,
            contents: innerContents.content,
            minimumSequenceNumber: message.minimumSequenceNumber,
            origin: message.origin,
            referenceSequenceNumber: message.referenceSequenceNumber,
            sequenceNumber: message.sequenceNumber,
            timestamp: message.timestamp,
            traces: message.traces,
            type: innerContents.type,
        };

        return component.prepare(transformed, local);
    }

    private processOperation(message: ISequencedDocumentMessage, local: boolean, context: any) {
        const envelope = message.contents as IEnvelope;
        const component = this.componentContexts.get(envelope.address);
        assert(component);
        const innerContents = envelope.contents as { content: any, type: string };

        const transformed: ISequencedDocumentMessage = {
            clientId: message.clientId,
            clientSequenceNumber: message.clientSequenceNumber,
            contents: innerContents.content,
            minimumSequenceNumber: message.minimumSequenceNumber,
            origin: message.origin,
            referenceSequenceNumber: message.referenceSequenceNumber,
            sequenceNumber: message.sequenceNumber,
            timestamp: message.timestamp,
            traces: message.traces,
            type: innerContents.type,
        };

        component.process(transformed, local, context);
    }

    private async prepareAttach(message: ISequencedDocumentMessage, local: boolean): Promise<ComponentContext> {
        this.verifyNotClosed();

        // the local object has already been attached
        if (local) {
            return;
        }

        const attachMessage = message.contents as IAttachMessage;
        let snapshotTree: ISnapshotTree = null;
        if (attachMessage.snapshot) {
            const flattened = flatten(attachMessage.snapshot.entries, new Map());
            snapshotTree = buildHierarchy(flattened);
        }

        // create storage service that wraps the attach data
        const runtimeStorage = new ComponentStorageService(this.storage, new Map());
        const component = new ComponentContext(
            this,
            attachMessage.type,
            attachMessage.id,
            true,
            runtimeStorage,
            snapshotTree);

        return component;
    }

    private processAttach(message: ISequencedDocumentMessage, local: boolean, context: ComponentContext): void {
        this.verifyNotClosed();
        debug("processAttach");
    }

    private async postProcessAttach(
        message: ISequencedDocumentMessage,
        local: boolean,
        context: ComponentContext,
    ): Promise<void> {
        const attachMessage = message.contents as IAttachMessage;

        // If a non-local operation then go and create the object - otherwise mark it as officially attached.
        if (local) {
            assert(this.pendingAttach.has(attachMessage.id));
            this.pendingAttach.delete(attachMessage.id);
        } else {
            this.componentContexts.set(attachMessage.id, context);

            // Fully start the component
            await context.start();

            // Resolve pending gets and store off any new ones
            if (this.componentContextsDeferred.has(attachMessage.id)) {
                this.componentContextsDeferred.get(attachMessage.id).resolve(context);
            } else {
                const deferred = new Deferred<ComponentContext>();
                deferred.resolve(context);
                this.componentContextsDeferred.set(attachMessage.id, deferred);
            }
        }
    }

    private startLeaderElection() {
        if (this.deltaManager && this.deltaManager.clientType === Browser) {
            if (this.connected) {
                this.initLeaderElection();
            } else {
                this.once("connected", () => this.initLeaderElection());
            }
        }
    }

    private initLeaderElection() {
        this.leaderElector = new LeaderElector(this.getQuorum(), this.clientId);
        this.leaderElector.on("newLeader", (clientId: string) => {
            debug(`New leader elected: ${clientId}`);
            if (this.leader) {
                this.emit("leader", clientId);
                for (const [, component] of this.componentContexts) {
                    component.updateLeader(clientId);
                }
                this.runTaskAnalyzer();
            }
        });
        this.leaderElector.on("leaderLeft", (clientId: string) => {
            debug(`Leader ${clientId} left`);
            this.proposeLeadership();
        });
        this.leaderElector.on("noLeader", (clientId: string) => {
            debug(`No leader present. Member ${clientId} left`);
            this.proposeLeadership();
        });
        this.leaderElector.on("memberLeft", (clientId: string) => {
            debug(`Member ${clientId} left`);
            if (this.leader) {
                this.runTaskAnalyzer();
            }
        });
        this.proposeLeadership();
    }

    private proposeLeadership() {
        this.leaderElector.proposeLeadership().then(() => {
            debug(`Leadership proposal accepted for ${this.clientId}`);
        }, (err) => {
            debug(`Leadership proposal rejected ${err}`);
        });
    }

    /**
     * On a client joining/departure, decide whether this client is the new leader.
     * If so, calculate if there are any unhandled tasks for browsers and remote agents.
     * Emit local help message for this browser and submits a remote help message for agents.
     */
    private runTaskAnalyzer() {
        // Analyze the current state and ask for local and remote help separately.
        const helpTasks = analyzeTasks(this.clientId, this.getQuorum().getMembers(), this.tasks);
        if (helpTasks && (helpTasks.browser.length > 0 || helpTasks.robot.length > 0)) {
            if (helpTasks.browser.length > 0) {
                const localHelpMessage: IHelpMessage = {
                    tasks: helpTasks.browser,
                    version: this.version,   // back-compat
                };
                debug(`Requesting local help for ${helpTasks.browser}`);
                this.emit("localHelp", localHelpMessage);
            }
            if (helpTasks.robot.length > 0) {
                const remoteHelpMessage: IHelpMessage = {
                    tasks: helpTasks.robot,
                    version: this.version,   // back-compat
                };
                debug(`Requesting remote help for ${helpTasks.robot}`);
                this.submit(MessageType.RemoteHelp, remoteHelpMessage);
            }
        }
    }
}
