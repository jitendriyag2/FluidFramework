// tslint:disable:align whitespace no-trailing-whitespace no-string-literal object-literal-sort-keys
import performanceNow = require("performance-now");
import * as url from "url";
import * as API from "../../api";
import * as SharedString from "../../merge-tree";
import * as Geometry from "./geometry";

enum CharacterCodes {
    _ = 95,
    $ = 36,

    ampersand = 38,             // &
    asterisk = 42,              // *
    at = 64,                    // @
    backslash = 92,             // \
    bar = 124,                  // |
    caret = 94,                 // ^
    closeBrace = 125,           // }
    closeBracket = 93,          // ]
    closeParen = 41,            // )
    colon = 58,                 // : 
    comma = 44,                 // ,
    dot = 46,                   // .
    doubleQuote = 34,           // "
    equals = 61,                // =
    exclamation = 33,           // !
    hash = 35,                  // #
    greaterThan = 62,           // >
    lessThan = 60,              // <
    minus = 45,                 // -
    openBrace = 123,            // {
    openBracket = 91,           // [
    openParen = 40,             // (
    percent = 37,               // %
    plus = 43,                  // +
    question = 63,              // ?
    semicolon = 59,             // ;
    singleQuote = 39,           // '
    slash = 47,                 // /
    tilde = 126,                // ~
    linefeed = 10,              // \n
    cr = 13,                    // \r
    _0 = 48,
    _9 = 57,
    a = 97,
    z = 122,

    A = 65,
    Z = 90,
    space = 0x0020,   // " "
}

interface IParagraphInfo {
    breaks: number[];
    singleLineWidth: number;
    endOffset?: number;
}

interface IParagraphMarker extends SharedString.Marker {
    cache?: IParagraphInfo;
}

export interface ILineDiv extends HTMLDivElement {
    linePos?: number;
    lineEnd?: number;
}

interface ISegSpan extends HTMLSpanElement {
    seg: SharedString.TextSegment;
    segPos?: number;
    offset?: number;
    clipOffset?: number;
    textErrorRun?: IRange;
}

interface IRangeInfo {
    elm: HTMLElement;
    node: Node;
    offset: number;
}

export interface Item {
    key: string;
    div?: HTMLDivElement;
    iconURL?: string;
}

export function namesToItems(names: string[]): Item[] {
    let items: Item[] = new Array(names.length);

    for (let i = 0, len = names.length; i < len; i++) {
        items[i] = { key: names[i] };
    }

    return items;
}

function altsToItems(alts: Alt[]) {
    return alts.map((v) => ({ key: v.text }));
}

type Alt = SharedString.Collections.ProxString<number>;
// TODO: mechanism for intelligent services to publish interfaces like this
interface ITextErrorInfo {
    text: string;
    alternates: Alt[];
    color?: string;
}

export interface ISelectionListBox {
    elm: HTMLDivElement;
    show();
    hide();
    prevItem();
    nextItem();
    removeHighlight();
    showSelectionList(selectionItems: Item[], hintSelection?: string);
    selectItem(key: string);
    items(): Item[];
    getSelectedKey(): string;
}

export function selectionListBoxCreate(textRect: Geometry.Rectangle, container: HTMLElement,
    itemHeight: number, offsetY: number, varHeight?: number): ISelectionListBox {
    let listContainer = document.createElement("div");
    let items: Item[];
    let itemCapacity: number;
    let bubble: HTMLDivElement;
    let bubbleDelta: number;
    let selectionIndex = -1;
    let topSelection = 0;

    init();

    return {
        elm: listContainer,
        getSelectedKey,
        hide: () => {
            listContainer.style.visibility = "hidden";
        },
        items: () => items,
        prevItem,
        nextItem,
        removeHighlight,
        selectItem: selectItemByKey,
        show: () => {
            listContainer.style.visibility = "visible";
        },
        showSelectionList,
    };

    function selectItemByKey(key: string) {
        key = key.trim();
        if (selectionIndex >= 0) {
            if (items[selectionIndex].key === key) {
                return;
            }
        }
        for (let i = 0, len = items.length; i < len; i++) {
            if (items[i].key === key) {
                selectItem(i);
                break;
            }
        }
    }

    function getSelectedKey() {
        if (selectionIndex >= 0) {
            return items[selectionIndex].key;
        }
    }

    function prevItem() {
        if (selectionIndex > 0) {
            selectItem(selectionIndex - 1);
        }
    }

    function nextItem() {
        if (selectionIndex < (items.length - 1)) {
            selectItem(selectionIndex + 1);
        }
    }

    function init() {
        listContainer.style.boxShadow = "0px 3px 2px #bbbbbb";
        listContainer.style.backgroundColor = "white";
        listContainer.style.border = "#e5e5e5 solid 2px";

        updateRectangles();
        container.appendChild(listContainer);
    }

    function updateRectangles() {
        let width = textRect.width;
        let height = window.innerHeight / 3;
        let top: number;
        let bottom: number;
        let right: number;
        if ((textRect.x + textRect.width) > window.innerWidth) {
            right = textRect.x;
        }
        // TODO: use container div instead of window/doc body
        // TODO: right/left (for now assume go right)
        if ((height + textRect.y + offsetY + textRect.height) >= window.innerHeight) {
            bottom = window.innerHeight - textRect.y;
        } else {
            top = textRect.y + textRect.height;
        }
        itemCapacity = Math.floor(height / itemHeight);
        if (top !== undefined) {
            let listContainerRect = new Geometry.Rectangle(textRect.x, top, width, height);
            listContainerRect.height = itemCapacity * itemHeight;
            listContainerRect.conformElementMaxHeight(listContainer);
        } else {
            let listContainerRect = new Geometry.Rectangle(textRect.x, 0, width, height);
            listContainerRect.height = itemCapacity * itemHeight;
            listContainerRect.conformElementMaxHeightFromBottom(listContainer, bottom);
        }
        if (right !== undefined) {
            listContainer.style.right = (window.innerWidth - right) + "px";
            listContainer.style.left = "";
        }
        if (varHeight) {
            listContainer.style.paddingBottom = varHeight + "px";
        }
    }

    function removeHighlight() {
        if (selectionIndex >= 0) {
            if (items[selectionIndex].div) {
                items[selectionIndex].div.style.backgroundColor = "white";
            }
        }
    }

    function selectItem(indx: number) {
        // then scroll if necessary
        if (indx < topSelection) {
            topSelection = indx;
        } else if ((indx - topSelection) >= itemCapacity) {
            topSelection = (indx - itemCapacity) + 1;
        }
        if (selectionIndex !== indx) {
            selectionIndex = indx;
            updateSelectionList();
        }
    }

    function addScrollbar() {
        let scrollbarWidth = 10;
        let scrollbar = document.createElement("div");
        bubble = document.createElement("div");

        let rect = Geometry.Rectangle.fromClientRect(listContainer.getBoundingClientRect());
        // adjust for 2px border
        rect.x = (rect.width - scrollbarWidth) - 4;
        rect.width = scrollbarWidth;
        rect.y = 0;
        rect.height -= 4;
        rect.conformElement(scrollbar);
        scrollbar.style.backgroundColor = "white";
        rect.y = 0;
        rect.x = 0;
        bubbleDelta = rect.height * (1 / items.length);
        rect.height = Math.round(itemCapacity * bubbleDelta);
        rect.conformElement(bubble);
        bubble.style.backgroundColor = "#cccccc";
        listContainer.appendChild(scrollbar);
        scrollbar.appendChild(bubble);
        scrollbar.style.zIndex = "2";
    }

    function adjustScrollbar() {
        bubble.style.top = Math.round(bubbleDelta * topSelection) + "px";
    }

    function makeItemDiv(i: number, div: HTMLDivElement) {
        let item = items[i];
        let itemDiv = div;
        itemDiv.style.fontSize = "18px";
        itemDiv.style.fontFamily = "Segoe UI";
        itemDiv.style.lineHeight = itemHeight + "px";
        itemDiv.style.whiteSpace = "pre";
        items[i].div = itemDiv;
        let itemSpan = document.createElement("span");
        itemSpan.innerText = "  " + item.key;
        itemDiv.appendChild(itemSpan);

        if (item.iconURL) {
            let icon = document.createElement("img");
            icon.style.cssFloat = "left";
            icon.style.height = itemHeight + "px";
            icon.style.width = itemHeight + "px";
            icon.setAttribute("src", item.iconURL);
            itemDiv.insertBefore(icon, itemSpan);
        }
        return itemDiv;
    }

    function showSelectionList(selectionItems: Item[], hintSelection?: string) {
        topSelection = 0;
        items = selectionItems;
        clearSubtree(listContainer);
        selectionIndex = -1;
        if (selectionItems.length === 0) {
            return;
        }
        bubble = undefined;
        if (items.length > itemCapacity) {
            setTimeout(addScrollbar, 0);
        }
        updateSelectionList();

        if (hintSelection) {
            selectItemByKey(hintSelection);
        } else {
            selectItem(0);
        }
    }

    function updateSelectionList() {
        let render = false;
        clearSubtree(listContainer);
        let len = items.length;
        for (let i = 0; i < itemCapacity; i++) {
            let indx = i + topSelection;
            if (indx === len) {
                break;
            } else {
                let item = items[indx];
                if (!item.div) {
                    item.div = document.createElement("div");
                    listContainer.appendChild(item.div);
                    makeItemDiv(indx, item.div);
                    render = true;
                } else {
                    listContainer.appendChild(item.div);
                }
                if (indx === selectionIndex) {
                    item.div.style.backgroundColor = "#aaaaff";
                } else {
                    item.div.style.backgroundColor = "white";
                }
            }
        }
        if (bubble) {
            adjustScrollbar();
        }
    }
}

function elmOffToSegOff(elmOff: IRangeInfo, span: HTMLSpanElement) {
    if ((elmOff.elm !== span) && (elmOff.elm.parentElement !== span)) {
        console.log("did not hit span");
    }
    let offset = elmOff.offset;
    let prevSib = elmOff.node.previousSibling;
    if ((!prevSib) && (elmOff.elm !== span)) {
        prevSib = elmOff.elm.previousSibling;
    }
    while (prevSib) {
        switch (prevSib.nodeType) {
            case Node.ELEMENT_NODE:
                let innerSpan = <HTMLSpanElement>prevSib;
                offset += innerSpan.innerText.length;
                break;
            case Node.TEXT_NODE:
                offset += prevSib.nodeValue.length;
                break;
            default:
                break;
        }
        prevSib = prevSib.previousSibling;
    }
    return offset;
}

let cachedCanvas: HTMLCanvasElement;
let underlineStringURL = `url(${url.resolve(document.baseURI, "/public/images/underline.gif")}) bottom repeat-x`;
// tslint:disable:max-line-length
let underlinePaulStringURL = `url(${url.resolve(document.baseURI, "/public/images/underline-paul.gif")}) bottom repeat-x`;

function getTextWidth(text: string, font: string) {
    // re-use canvas object for better performance
    const canvas = cachedCanvas || (cachedCanvas = document.createElement("canvas"));
    const context = canvas.getContext("2d");
    context.font = font;
    const metrics = context.measureText(text);
    return metrics.width;
}

function getMultiTextWidth(texts: string[], font: string) {
    // re-use canvas object for better performance
    const canvas = cachedCanvas || (cachedCanvas = document.createElement("canvas"));
    const context = canvas.getContext("2d");
    context.font = font;
    let sum = 0;
    for (let text of texts) {
        const metrics = context.measureText(text);
        sum += metrics.width;
    }
    return sum;
}

function makeScrollLosenge(height: number, left: number, top: number) {
    let div = document.createElement("div");
    div.style.width = "12px";
    div.style.height = `${height}px`;
    div.style.left = `${left}px`;
    div.style.top = `${top}px`;
    div.style.backgroundColor = "pink";
    let bordRad = height / 3;
    div.style.borderRadius = `${bordRad}px`;
    div.style.position = "absolute";
    return div;
}

interface IRange {
    start: number;
    end: number;
}

enum ParagraphItemType {
    Block,
    Glue,
    Penalty,
}

interface IPGItem {
    type: ParagraphItemType;
    width: number;
    textSegment: SharedString.TextSegment;
}

interface IPGBlock extends IPGItem {
    type: ParagraphItemType.Block;
    text: string;
}

function makeIPGBlock(width: number, text: string, textSegment: SharedString.TextSegment) {
    return <IPGBlock>{ type: ParagraphItemType.Block, width, text, textSegment };
}

function makeGlue(width: number, text: string, textSegment: SharedString.TextSegment,
    stretch: number, shrink: number) {
    return <IPGGlue>{ type: ParagraphItemType.Glue, width, text, textSegment, stretch, shrink };
}

interface IPGGlue extends IPGItem {
    type: ParagraphItemType.Glue;
    text: string;
    stretch: number;
    shrink: number;
}

interface IPGPenalty extends IPGItem {
    type: ParagraphItemType.Penalty;
    cost: number;
}

type PGItem = IPGBlock | IPGGlue | IPGPenalty;

// for now assume uniform line widths 
function breakPGIntoLinesFF(items: PGItem[], lineWidth: number) {
    let breaks = [0];
    let posInPG = 0;
    let committedItemsWidth = 0;
    let blockRunWidth = 0;
    let blockRunPos = -1;
    let prevIsGlue = true;
    for (let item of items) {
        if (item.type === ParagraphItemType.Block) {
            if (prevIsGlue) {
                blockRunPos = posInPG;
                blockRunWidth = 0;
            }
            if ((committedItemsWidth + item.width) > lineWidth) {
                breaks.push(blockRunPos);
                committedItemsWidth = blockRunWidth;
            }
            posInPG += item.text.length;
            blockRunWidth += item.width;
            prevIsGlue = false;
        } else if (item.type === ParagraphItemType.Glue) {
            posInPG++;
            prevIsGlue = true;
        }
        committedItemsWidth += item.width;
    }
    return breaks;
}

function findContainingTile(client: SharedString.Client, pos: number, tileType: string) {
    let tileMarker: SharedString.Marker;
    function recordPGStart(segment: SharedString.Segment) {
        if (segment.getType() === SharedString.SegmentType.Marker) {
            let marker = <SharedString.Marker>segment;
            if (marker.type === tileType) {
                tileMarker = marker;
            }
        }
        return false;
    }

    function shift(node: SharedString.Node, segpos: number, refSeq: number, clientId: number, offset: number) {
        if (node.isLeaf()) {
            let seg = <SharedString.Segment>node;
            if ((seg.netLength() > 0) && (seg.getType() === SharedString.SegmentType.Marker)) {
                let marker = <SharedString.Marker>seg;
                if (marker.type === tileType) {
                    tileMarker = marker;
                }
            }
        } else {
            let block = <SharedString.HierBlock>node;
            let marker = <SharedString.Marker>block.rightmostTiles[tileType];
            if (marker !== undefined) {
                tileMarker = marker;
            }

        }
        return true;
    }

    client.mergeTree.search(pos, SharedString.UniversalSequenceNumber, client.getClientId(),
        { leaf: recordPGStart, shift });
    return tileMarker;
}

const enum ParagraphLexerState {
    AccumBlockChars,
    AccumSpaces,
}

type ParagraphTokenAction = (text: string, type: ParagraphItemType, leadSegment: SharedString.TextSegment) => void;

class ParagraphLexer {
    public state = ParagraphLexerState.AccumBlockChars;
    private spaceCount = 0;
    private textBuf = "";
    private leadSegment: SharedString.TextSegment;

    constructor(public tokenAction: ParagraphTokenAction) {
    }

    public reset() {
        this.state = ParagraphLexerState.AccumBlockChars;
        this.spaceCount = 0;
        this.textBuf = "";
        this.leadSegment = undefined;
    }

    public lex(textSegment: SharedString.TextSegment) {
        if (this.leadSegment && (!this.leadSegment.matchProperties(textSegment))) {
            this.emit();
            this.leadSegment = textSegment;
        } else if (!this.leadSegment) {
            this.leadSegment = textSegment;
        }
        let segText = textSegment.text;
        for (let i = 0, len = segText.length; i < len; i++) {
            let c = segText.charAt(i);
            if (c === " ") {
                if (this.state === ParagraphLexerState.AccumBlockChars) {
                    this.emitBlock();
                }
                this.state = ParagraphLexerState.AccumSpaces;
                this.spaceCount++;
            } else {
                if (this.state === ParagraphLexerState.AccumSpaces) {
                    this.emitGlue();
                }
                this.state = ParagraphLexerState.AccumBlockChars;
                this.textBuf += c;
            }
        }
        this.emit();
    }

    private emit() {
        if (this.state === ParagraphLexerState.AccumBlockChars) {
            this.emitBlock();
        } else {
            this.emitGlue();
        }
    }

    private emitGlue() {
        if (this.spaceCount > 0) {
            this.tokenAction(SharedString.internedSpaces(this.spaceCount), ParagraphItemType.Glue, this.leadSegment);
            this.spaceCount = 0;
        }
    }

    private emitBlock() {
        if (this.textBuf.length > 0) {
            this.tokenAction(this.textBuf, ParagraphItemType.Block, this.leadSegment);
            this.textBuf = "";
        }
    }

}
// global until remove old render
let textErrorRun: IRange;

interface ILineContext {
    lineDiv: ILineDiv;
    lineDivHeight: number;
    flowView: FlowView;
    span: ISegSpan;
    pgMarker: IParagraphMarker;
    markerPos: number;
    viewportBounds: Geometry.Rectangle;
}

function renderSegmentIntoLine(segment: SharedString.Segment, segpos: number, refSeq: number,
    clientId: number, start: number, end: number, lineContext: ILineContext) {
    if (lineContext.lineDiv.linePos === undefined) {
        lineContext.lineDiv.linePos = segpos + start;
        lineContext.lineDiv.lineEnd = lineContext.lineDiv.linePos;
    }
    let segType = segment.getType();
    if (segType === SharedString.SegmentType.Text) {
        if (start < 0) {
            start = 0;
        }
        if (end > segment.cachedLength) {
            end = segment.cachedLength;
        }
        let textSegment = <SharedString.TextSegment>segment;
        let text = textSegment.text.substring(start, end);
        let textStartPos = segpos + start;
        let textEndPos = segpos + end;
        lineContext.span = makeSegSpan(lineContext.flowView, text, textSegment, start, segpos);
        lineContext.lineDiv.appendChild(lineContext.span);
        lineContext.lineDiv.lineEnd += text.length;
        if ((lineContext.flowView.cursor.pos >= textStartPos) && (lineContext.flowView.cursor.pos < textEndPos)) {
            let cursorX: number;
            if (lineContext.flowView.cursor.pos > textStartPos) {
                let preCursorText = text.substring(0, lineContext.flowView.cursor.pos - textStartPos);
                let temp = lineContext.span.innerText;
                lineContext.span.innerText = preCursorText;
                let cursorBounds = lineContext.span.getBoundingClientRect();
                cursorX = cursorBounds.width + (cursorBounds.left - lineContext.viewportBounds.x);
                lineContext.span.innerText = temp;
            } else {
                let cursorBounds = lineContext.span.getBoundingClientRect();
                cursorX = cursorBounds.left - lineContext.viewportBounds.x;
            }
            lineContext.flowView.cursor.assignToLine(cursorX, lineContext.lineDivHeight, lineContext.lineDiv);
        }
    } else if (segType === SharedString.SegmentType.Marker) {
        let marker = <SharedString.Marker>segment;
        if (marker.type === "pg") {
            lineContext.pgMarker = marker;
            lineContext.markerPos = segpos;
            if (lineContext.flowView.cursor.pos === segpos) {
                if (lineContext.span) {
                    let cursorBounds = lineContext.span.getBoundingClientRect();
                    let cursorX = cursorBounds.width + (cursorBounds.left - lineContext.viewportBounds.x);
                    lineContext.flowView.cursor.assignToLine(cursorX, lineContext.lineDivHeight, lineContext.lineDiv);
                } else {
                    lineContext.flowView.cursor.assignToLine(0, lineContext.lineDivHeight, lineContext.lineDiv);
                }
            }
            return false;
        }
    }
    return true;
}

function findLineDiv(pos: number, flowView: FlowView) {
    let elm = <ILineDiv>flowView.viewportDiv.firstElementChild;
    while (elm) {
        if (elm.linePos !== undefined) {
            if ((elm.linePos <= pos) && (elm.lineEnd > pos)) {
                return elm;
            }
        }
        elm = <ILineDiv>elm.nextElementSibling;
    }
}

function reRenderLine(lineDiv: ILineDiv, flowView: FlowView) {
    if (lineDiv) {
        let viewportBounds = Geometry.Rectangle.fromClientRect(flowView.viewportDiv.getBoundingClientRect());
        let lineDivBounds = lineDiv.getBoundingClientRect();
        let lineDivHeight = lineDivBounds.height;
        clearSubtree(lineDiv);
        let lineContext = <ILineContext>{
            flowView, lineDiv, span: undefined, pgMarker: undefined, markerPos: 0,
            viewportBounds, lineDivHeight,
        };
        let lineEnd = lineDiv.lineEnd;
        flowView.client.mergeTree.mapRange({ leaf: renderSegmentIntoLine }, SharedString.UniversalSequenceNumber,
            flowView.client.getClientId(), lineContext, lineDiv.linePos, lineDiv.lineEnd);
        lineDiv.lineEnd = lineEnd;
    }
}

function renderTree(div: HTMLDivElement, pos: number, client: SharedString.Client, flowView: FlowView) {
    let fontstr = "18px Times";
    let headerFontstr = "22px Times";
    // TODO: for stable viewports cache the geometry and the divs 
    div.id = "renderedTree";

    let viewportBounds = Geometry.Rectangle.fromClientRect(div.getBoundingClientRect());
    let pgCount = 0;
    div.style.font = fontstr;
    let computedStyle = window.getComputedStyle(div);
    let defaultLineHeight = 1.2;
    let viewportHeight = parseInt(div.style.height, 10);
    let viewportWidth = parseInt(div.style.width, 10);
    let h = parseInt(computedStyle.fontSize, 10);
    let defaultLineDivHeight = Math.round(h * defaultLineHeight);
    let pgVspace = Math.round(h * 0.5);
    let headerDivHeight = 32;
    let currentLineTop = 0;
    let wordSpacing = getTextWidth(" ", fontstr);
    let viewportStartPos = -1;
    let lineCount = 0;
    let lastLineDiv  = undefined;

    let makeLineDiv = (r: Geometry.Rectangle, lineFontstr) => {
        let lineDiv = document.createElement("div");
        lineDiv.style.font = lineFontstr;
        lineDiv.style.whiteSpace = "pre";
        lineDiv.onclick = (e) => {
            let targetDiv = <HTMLDivElement>e.target;
            if (targetDiv.lastElementChild) {
                // tslint:disable-next-line:max-line-length
                console.log(`div click at ${e.clientX},${e.clientY} rightmost span with text ${targetDiv.lastElementChild.innerHTML}`);
            }
        };
        r.conformElement(lineDiv);
        div.appendChild(lineDiv);
        lineCount++;
        lastLineDiv = lineDiv;
        return lineDiv;
    };

    let items: PGItem[];

    function tokenToItems(text: string, type: ParagraphItemType, leadSegment: SharedString.TextSegment) {
        let lfontstr = fontstr;
        if (startPGMarker.properties && (startPGMarker.properties.header !== undefined)) {
            lfontstr = headerFontstr;
        }
        if (leadSegment.properties) {
            let fontSize = leadSegment.properties.fontSize;
            if (fontSize) {
                lfontstr = `${fontSize} Times`;
            }
            let fontStyle = leadSegment.properties.fontStyle;
            if (fontStyle) {
                lfontstr = fontStyle + " " + lfontstr;
            }
        }

        let textWidth = getTextWidth(text, lfontstr);
        if (type === ParagraphItemType.Block) {
            items.push(makeIPGBlock(textWidth, text, leadSegment));
        } else {
            items.push(makeGlue(textWidth, text, leadSegment, wordSpacing / 2, wordSpacing / 3));
        }
    }

    let pgMarker: IParagraphMarker;
    let startPGMarker: IParagraphMarker;
    let markerPos: number;
    let paragraphLexer = new ParagraphLexer(tokenToItems);
    textErrorRun = undefined;

    function segmentToItems(segment: SharedString.Segment, segpos: number) {
        if (segment.getType() === SharedString.SegmentType.Text) {
            let textSegment = <SharedString.TextSegment>segment;
            paragraphLexer.lex(textSegment);
        } else if (segment.getType() === SharedString.SegmentType.Marker) {
            let marker = <SharedString.Marker>segment;
            if (marker.type === "pg") {
                return false;
            }
        }
        return true;
    }

    function renderPG(curPGMarker: IParagraphMarker, curPGPos: number) {
        let pgBreaks = curPGMarker.cache.breaks;
        let lineDiv: ILineDiv;
        let lineDivHeight = defaultLineDivHeight;
        let span: HTMLSpanElement;

        for (let breakIndex = 0, len = pgBreaks.length; breakIndex < len; breakIndex++) {
            let lineStart = pgBreaks[breakIndex] + curPGPos;
            let lineEnd: number;
            if (breakIndex < (len - 1)) {
                lineEnd = pgBreaks[breakIndex + 1] + curPGPos;
            } else {
                lineEnd = undefined;
            }
            let lineFontstr = fontstr;
            lineDivHeight = defaultLineDivHeight;
            if ((lineEnd === undefined) || (lineEnd >= pos)) {
                if (curPGMarker.properties && (curPGMarker.properties.header !== undefined)) {
                    // TODO: header levels
                    lineDivHeight = headerDivHeight;
                    lineFontstr = headerFontstr;
                }
                lineDiv = makeLineDiv(new Geometry.Rectangle(0, currentLineTop, viewportWidth, lineDivHeight),
                    lineFontstr);
                let lineContext = <ILineContext>{
                    span, lineDiv, lineDivHeight, flowView, pgMarker, markerPos,
                    viewportBounds,
                };
                if (viewportStartPos < 0) {
                    viewportStartPos = lineStart;
                }
                client.mergeTree.mapRange({ leaf: renderSegmentIntoLine }, SharedString.UniversalSequenceNumber,
                    client.getClientId(), lineContext, lineStart, lineEnd);
                span = lineContext.span;
                markerPos = lineContext.markerPos;
                pgMarker = lineContext.pgMarker;

                currentLineTop += lineDivHeight;
            }
            if ((viewportHeight - currentLineTop) < defaultLineDivHeight) {
                // no more room for lines
                // TODO: record end viewport char
                break;
            }
        }
    }

    pgMarker = findContainingTile(client, pos, "pg");
    markerPos = client.mergeTree.getOffset(pgMarker, SharedString.UniversalSequenceNumber,
        client.getClientId());

    let startPGPos: number;

    do {
        items = [];
        startPGMarker = pgMarker;
        pgMarker = undefined;
        startPGPos = markerPos + 1;
        if ((!startPGMarker.cache) || (startPGMarker.cache.singleLineWidth !== viewportBounds.width)) {
            client.mergeTree.mapRange({ leaf: segmentToItems }, SharedString.UniversalSequenceNumber,
                client.getClientId(), undefined, startPGPos);
            startPGMarker.cache = { breaks: breakPGIntoLinesFF(items, viewportBounds.width), singleLineWidth: viewportBounds.width };
        }
        pgCount++;
        paragraphLexer.reset();
        renderPG(startPGMarker, startPGPos);
        currentLineTop += pgVspace;
        if (pgMarker !== undefined) {
            startPGMarker.cache.endOffset = markerPos - startPGPos;
        } else {
            startPGMarker.cache.endOffset = lastLineDiv.lineEnd - startPGPos;
        }
    } while ((pgMarker !== undefined) && ((viewportHeight - currentLineTop) >= defaultLineDivHeight));
    flowView.viewportStartPos = viewportStartPos;
    flowView.viewportEndPos = startPGMarker.cache.endOffset + startPGPos;
}

function makeSegSpan(context: FlowView, segText: string, textSegment: SharedString.TextSegment, offsetFromSegpos: number,
    segpos: number) {
    let span = <ISegSpan>document.createElement("span");
    span.innerText = segText;
    span.seg = textSegment;
    span.segPos = segpos;
    let textErr = false;
    if (textSegment.properties) {
        // tslint:disable-next-line
        for (let key in textSegment.properties) {
            if (key === "textError") {
                textErr = true;
                if (textErrorRun === undefined) {
                    textErrorRun = { start: segpos + offsetFromSegpos, end: segpos + offsetFromSegpos + segText.length };
                } else {
                    textErrorRun.end += segText.length;
                }
                let textErrorInfo = <ITextErrorInfo>textSegment.properties[key];
                let slb: ISelectionListBox;
                span.textErrorRun = textErrorRun;
                if (textErrorInfo.color) {
                    span.style.background = underlinePaulStringURL;
                } else {
                    span.style.background = underlineStringURL;
                }
                if (textErrorInfo.alternates.length > 0) {
                    span.onmousedown = (e) => {
                        function cancelIntellisense(ev: MouseEvent) {
                            if (slb) {
                                document.body.removeChild(slb.elm);
                                slb = undefined;
                            }
                        }
                        function acceptIntellisense(ev: MouseEvent) {
                            cancelIntellisense(ev);
                            let itemElm = <HTMLElement>ev.target;
                            let text = itemElm.innerText.trim();
                            context.sharedString.removeText(span.textErrorRun.start, span.textErrorRun.end);
                            context.sharedString.insertText(text, span.textErrorRun.start);
                            context.localQueueRender(span.textErrorRun.start);
                        }
                        function selectItem(ev: MouseEvent) {
                            let itemElm = <HTMLElement>ev.target;
                            if (slb) {
                                slb.selectItem(itemElm.innerText);
                            }
                            // console.log(`highlight ${itemElm.innerText}`);
                        }
                        console.log(`button ${e.button}`);
                        if ((e.button === 2) || ((e.button === 0) && (e.ctrlKey))) {
                            let spanBounds = Geometry.Rectangle.fromClientRect(span.getBoundingClientRect());
                            spanBounds.width = Math.floor(window.innerWidth / 4);
                            slb = selectionListBoxCreate(spanBounds, document.body, 24, 0, 12);
                            slb.showSelectionList(altsToItems(textErrorInfo.alternates));
                            span.onmouseup = cancelIntellisense;
                            document.body.onmouseup = cancelIntellisense;
                            slb.elm.onmouseup = acceptIntellisense;
                            slb.elm.onmousemove = selectItem;
                        }
                    };
                }
            } else {
                span.style[key] = textSegment.properties[key];
            }
        }
    }
    if (!textErr) {
        textErrorRun = undefined;
    }
    if (offsetFromSegpos > 0) {
        span.offset = offsetFromSegpos;
    }
    return span;
}

function pointerToElementOffsetWebkit(x: number, y: number): IRangeInfo {
    let range = document.caretRangeFromPoint(x, y);
    if (range) {
        let result = {
            elm: <HTMLElement>range.startContainer.parentElement,
            node: range.startContainer,
            offset: range.startOffset,
        };
        range.detach();
        return result;
    }
}

export function clearSubtree(elm: HTMLElement) {
    while (elm.lastChild) {
        elm.removeChild(elm.lastChild);
    }
}

export interface IStatus {
    add(key: string, msg: string);
    remove(key: string);
    overlay(msg: string);
    removeOverlay();
    onresize();
}

export interface IComponentContainer {
    div: HTMLDivElement;
    onresize: () => void;
    onkeydown: (e: KeyboardEvent) => void;
    onkeypress: (e: KeyboardEvent) => void;
    status: IStatus;
}

export class Cursor {
    public off = true;
    public parentSpan: HTMLSpanElement;
    public editSpan: HTMLSpanElement;
    private blinkCount = 0;
    private blinkTimer: any;
    private viewportDivBounds: ClientRect;

    constructor(public viewportDiv: HTMLDivElement, public pos = 1) {
        this.makeSpan();
        this.onresize();
    }

    public hide() {
        this.editSpan.style.visibility = "hidden";
    }

    public show() {
        this.editSpan.style.backgroundColor = "blue";
        this.editSpan.style.visibility = "visible";
    }

    public makeSpan() {
        this.editSpan = document.createElement("span");
        this.editSpan.id = "cursor";
        this.editSpan.innerText = "\uFEFF";
        this.editSpan.style.zIndex = "1";
        this.editSpan.style.position = "absolute";
        this.editSpan.style.left = "0px";
        this.editSpan.style.top = "0px";
        this.editSpan.style.width = "2px";
        this.show();
    }

    public lineDiv() {
        return <ILineDiv>this.editSpan.parentElement;
    }

    public updateView(flowView: FlowView) {
        let lineDiv = this.lineDiv();
        if (lineDiv && (lineDiv.linePos <= this.pos) && (lineDiv.lineEnd > this.pos)) {
            reRenderLine(lineDiv, flowView);
        } else {
            let foundLineDiv = findLineDiv(this.pos, flowView);
            if (foundLineDiv) {
                reRenderLine(foundLineDiv, flowView);
            } else {
                flowView.render(flowView.topChar, true);
            }
        }
    }

    public rect() {
        return this.editSpan.getBoundingClientRect();
    }

    public onresize() {
        this.viewportDivBounds = this.viewportDiv.getBoundingClientRect();
    }

    public assignToLine(x: number, h: number, lineDiv: HTMLDivElement) {
        this.editSpan.style.left = `${x}px`;
        this.editSpan.style.height = `${h}px`;
        if (this.editSpan.parentElement) {
            this.editSpan.parentElement.removeChild(this.editSpan);
        }
        lineDiv.appendChild(this.editSpan);
        if (this.blinkTimer) {
            clearTimeout(this.blinkTimer);
        }
        this.blinkCursor();
    }

    public assign(parentSpan: HTMLSpanElement) {
        if (this.editSpan.parentElement) {
            this.editSpan.parentElement.removeChild(this.editSpan);
        }
        parentSpan.style.position = "relative";
        parentSpan.appendChild(this.editSpan);
        this.parentSpan = parentSpan;
        // let bounds = parentSpan.getBoundingClientRect();
        // let left = bounds.left - this.viewportDivBounds.left;
        // let top = bounds.top - this.viewportDivBounds.top;

        // this.editSpan.style.left = `${left}px`;
        // this.editSpan.style.top = `${top}px`;
        if (this.blinkTimer) {
            clearTimeout(this.blinkTimer);
        }
        this.blinkCursor();
    }

    private blinker = () => {
        if (this.off) {
            this.show();
        } else {
            this.hide();
        }
        this.off = !this.off;
        if (this.blinkCount > 0) {
            this.blinkCount--;
            this.blinkTimer = setTimeout(this.blinker, 500);
        } else {
            this.show();
        }
    }

    private blinkCursor() {
        this.blinkCount = 30;
        this.off = true;
        this.blinkTimer = setTimeout(this.blinker, 20);
    }
}

enum KeyCode {
    backspace = 8,
    esc = 27,
    pageUp = 33,
    pageDown = 34,
    end = 35,
    home = 36,
    leftArrow = 37,
    upArrow = 38,
    rightArrow = 39,
    downArrow = 40,
    letter_a = 65,
    letter_z = 90,
}

export class FlowView {
    public static scrollAreaWidth = 18;

    public timeToImpression: number;
    public timeToLoad: number;
    public timeToEdit: number;
    public timeToCollab: number;
    public prevTopSegment: SharedString.TextSegment;
    public viewportStartPos: number;
    public viewportEndPos: number;
    public cursorSpan: HTMLSpanElement;
    public containerDiv: HTMLDivElement;
    public viewportDiv: HTMLDivElement;
    public viewportRect: Geometry.Rectangle;
    public scrollDiv: HTMLDivElement;
    public scrollRect: Geometry.Rectangle;
    public statusDiv: HTMLDivElement;
    public statusRect: Geometry.Rectangle;
    public client: SharedString.Client;
    public ticking = false;
    public wheelTicking = false;
    public topChar = 0;
    public cursor: Cursor;
    private lastVerticalX = -1;
    private randWordTimer: any;
    private pendingRender = false;
    private diagCharPort = false;

    constructor(
        public sharedString: SharedString.SharedString,
        public flowContainer: IComponentContainer) {

        this.containerDiv = flowContainer.div;
        this.client = sharedString.client;
        this.viewportDiv = document.createElement("div");
        this.containerDiv.appendChild(this.viewportDiv);
        this.scrollDiv = document.createElement("div");
        this.containerDiv.appendChild(this.scrollDiv);

        this.updateGeometry();
        this.statusMessage("li", " ");
        this.statusMessage("si", " ");
        sharedString.on("op", (msg: API.ISequencedObjectMessage) => {
            this.queueRender(msg);
        });

        this.cursor = new Cursor(this.viewportDiv);
    }

    public updateGeometry() {
        let bounds = Geometry.Rectangle.fromClientRect(this.containerDiv.getBoundingClientRect());
        Geometry.Rectangle.conformElementToRect(this.containerDiv, bounds);
        let panelScroll = bounds.nipHorizRight(FlowView.scrollAreaWidth);
        this.scrollRect = panelScroll[1];
        Geometry.Rectangle.conformElementToRect(this.scrollDiv, this.scrollRect);
        this.viewportRect = panelScroll[0].inner(0.92);
        Geometry.Rectangle.conformElementToRect(this.viewportDiv, this.viewportRect);
    }

    public statusMessage(key: string, msg: string) {
        this.flowContainer.status.add(key, msg);
    }

    public verticalMove(lineCount: number) {
        let cursorRect = this.cursor.rect();
        let x: number;
        if (this.lastVerticalX >= 0) {
            x = this.lastVerticalX;
        } else {
            x = Math.floor(cursorRect.left);
            this.lastVerticalX = x;
        }
        let y: number;
        let lineDiv = this.cursor.lineDiv();
        let targetLineDiv: ILineDiv;
        if (lineCount < 0) {
            targetLineDiv = <ILineDiv>lineDiv.previousElementSibling;
        } else {
            targetLineDiv = <ILineDiv>lineDiv.nextElementSibling;
        }
        if (targetLineDiv && (targetLineDiv.linePos)) {
            let targetLineBounds = targetLineDiv.getBoundingClientRect();
            y = targetLineBounds.top + Math.floor(targetLineBounds.height / 2);
            let elm = document.elementFromPoint(x, y);
            if (elm.tagName === "DIV") {
                let span = <ISegSpan>elm.lastElementChild;
                if (span) {
                    this.cursor.pos = targetLineDiv.lineEnd;
                    return true;
                } else {
                    // empty line
                    this.cursor.pos = targetLineDiv.linePos;
                    return true;
                }
            } else if (elm.tagName === "SPAN") {
                let span = <ISegSpan>elm;
                let elmOff = pointerToElementOffsetWebkit(x, y);
                if (elmOff) {
                    let computed = elmOffToSegOff(elmOff, span);
                    if (span.offset) {
                        computed += span.offset;
                    }
                    this.cursor.pos = span.segPos + computed;
                    return true;
                }
            }
        }
        return false;
    }

    public viewportCharCount() {
        return this.viewportEndPos - this.viewportStartPos;
    }

    public setEdit() {
        let preventD = (e) => {
            e.returnValue = false;
            e.preventDefault();
            return false;
        };

        window.oncontextmenu = preventD;
        this.containerDiv.onmousemove = preventD;
        this.containerDiv.onmouseup = preventD;
        this.containerDiv.onselectstart = preventD;

        this.containerDiv.onmousedown = (e) => {
            if (e.button === 0) {
                if (!this.diagCharPort) {
                    return;
                }
                let span = <ISegSpan>e.target;
                let segspan: ISegSpan;
                if (span.seg) {
                    segspan = span;
                } else {
                    segspan = <ISegSpan>span.parentElement;
                }
                if (segspan && segspan.seg) {
                    let segOffset = this.client.mergeTree.getOffset(segspan.seg, this.client.getCurrentSeq(),
                        this.client.getClientId());
                    let elmOff = pointerToElementOffsetWebkit(e.clientX, e.clientY);
                    let computed = elmOffToSegOff(elmOff, segspan);
                    // tslint:disable:max-line-length
                    let diag = `segPos: ${segOffset} cxy: (${e.clientX}, ${e.clientY}) within: ${elmOff.offset} computed: (${computed}, ${computed + segOffset})`;
                    if (this.diagCharPort) {
                        this.statusMessage("segclick", diag);
                    }
                    console.log(diag);
                }
            } else if (e.button === 2) {
                e.preventDefault();
                e.returnValue = false;
                return false;
            }
        };

        this.containerDiv.onmousewheel = (e) => {
            if (!this.wheelTicking) {
                let factor = 20;
                let inputDelta = e.wheelDelta;
                if (Math.abs(e.wheelDelta) === 120) {
                    inputDelta = e.wheelDelta / 6;
                } else {
                    inputDelta = e.wheelDelta / 2;
                }
                let delta = factor * inputDelta;
                // console.log(`top char: ${this.topChar - delta} factor ${factor}; delta: ${delta} wheel: ${e.wheelDeltaY} ${e.wheelDelta} ${e.detail}`);
                setTimeout(() => {
                    this.render(Math.floor(this.topChar - delta));
                    this.wheelTicking = false;
                }, 20);
                this.wheelTicking = true;
            }
            e.preventDefault();
            e.returnValue = false;
        };
        this.flowContainer.onresize = () => {
            this.updateGeometry();
            // this.cursor.onresize();
            this.render(this.topChar, true);
        };
        let keydownHandler = (e: KeyboardEvent) => {
            let saveLastVertX = this.lastVerticalX;
            let specialKey = true;
            this.lastVerticalX = -1;
            // console.log(`key ${e.keyCode}`);
            if (e.keyCode === KeyCode.backspace) {
                this.cursor.pos--;
                this.sharedString.removeText(this.cursor.pos, this.cursor.pos + 1);
                this.localQueueRender(this.cursor.pos);
            } else if (((e.keyCode === KeyCode.pageUp) || (e.keyCode === KeyCode.pageDown)) && (!this.ticking)) {
                setTimeout(() => {
                    this.scroll(e.keyCode === KeyCode.pageUp);
                    this.ticking = false;
                }, 20);
                this.ticking = true;
            } else if (e.keyCode === KeyCode.home) {
                this.cursor.pos = 1;
                this.render(1);
            } else if (e.keyCode === KeyCode.end) {
                let halfport = Math.floor(this.viewportCharCount() / 2);
                let topChar = this.client.getLength() - halfport;
                this.cursor.pos = topChar;
                this.render(topChar);
            } else if (e.keyCode === KeyCode.rightArrow) {
                if (this.cursor.pos < this.viewportEndPos) {
                    this.cursor.pos++;
                    this.cursor.updateView(this);
                }
            } else if (e.keyCode === KeyCode.leftArrow) {
                if (this.cursor.pos > 1) {
                    this.cursor.pos--;
                    this.cursor.updateView(this);
                }
            } else if ((e.keyCode === KeyCode.upArrow) || (e.keyCode === KeyCode.downArrow)) {
                this.lastVerticalX = saveLastVertX;
                let lineCount = 1;
                if (e.keyCode === KeyCode.upArrow) {
                    lineCount = -1;
                }
                // TODO: try twice; if first returns false, then scroll up/down once first
                if (this.verticalMove(lineCount)) {
                    this.cursor.updateView(this);
                }
            } else {
                specialKey = false;
            }
            if (specialKey) {
                e.preventDefault();
                e.returnValue = false;
            }
        };
        let keypressHandler = (e: KeyboardEvent) => {
            let pos = this.cursor.pos;
            this.cursor.pos++;
            let code = e.charCode;
            if (code === CharacterCodes.cr) {
                // TODO: pg properties on marker                
                this.sharedString.insertMarker(pos, "pg", SharedString.MarkerBehaviors.Tile);
                this.updatePGInfo(pos - 1);
            } else {
                this.sharedString.insertText(String.fromCharCode(code), pos);
            }
            this.localQueueRender(pos);
        };
        this.flowContainer.onkeydown = keydownHandler;
        this.flowContainer.onkeypress = keypressHandler;
    }

    public testWordInfo() {
        let text = this.sharedString.client.getText();
        let nonWhitespace = text.split(/\s+/g);
        console.log(`non ws count: ${nonWhitespace.length}`);
        let obj = new Object();
        for (let nws of nonWhitespace) {
            if (!obj[nws]) {
                obj[nws] = 1;
            } else {
                obj[nws]++;
            }
        }
        let count = 0;
        let uniques = <string[]>[];
        for (let key in obj) {
            if (obj.hasOwnProperty(key)) {
                count++;
                uniques.push(key);
            }
        }
        console.log(`${count} unique`);
        let clock = Date.now();
        getMultiTextWidth(uniques, "18px Times");
        console.log(`unique pp cost: ${Date.now() - clock}ms`);
    }

    public scroll(up: boolean) {
        let len = this.client.getLength();
        let halfport = Math.floor(this.viewportCharCount() / 2);
        if ((up && (this.topChar === 0)) || ((!up) && (this.topChar > (len - halfport)))) {
            return;
        }
        let scrollTo = this.topChar;
        if (up) {
            scrollTo -= halfport;
        } else {
            scrollTo += halfport;
        }
        this.render(scrollTo);
        if ((this.cursor.pos < this.viewportStartPos)||
            (this.cursor.pos > this.viewportEndPos)) {
                if (up) {
                    this.cursor.pos = this.viewportStartPos;
                } else {
                    this.cursor.pos = this.viewportEndPos - 1;   
                }
                this.cursor.updateView(this);
            }
    }

    public render(topChar?: number, changed = false) {
        let len = this.client.getLength();
        if (topChar !== undefined) {
            if (((this.topChar === topChar) || ((this.topChar === 0) && (topChar <= 0)))
                && (!changed)) {
                return;
            }
            this.topChar = topChar;
            if (this.topChar >= len) {
                this.topChar = len - (this.viewportCharCount()/2);
            }
            if (this.topChar < 1) {
                this.topChar = 1;
            }
        }
        let clk = Date.now();
        let frac = this.topChar / len;
        let pos = Math.floor(frac * len);
        clearSubtree(this.viewportDiv);
        // this.viewportDiv.appendChild(this.cursor.editSpan);
        renderTree(this.viewportDiv, pos, this.client, this);
        clearSubtree(this.scrollDiv);
        let bubbleHeight = Math.max(3, Math.floor((this.viewportCharCount() / len) * this.scrollRect.height));
        let bubbleTop = Math.floor(frac * this.scrollRect.height);
        let bubbleLeft = 3;
        let bubbleDiv = makeScrollLosenge(bubbleHeight, bubbleLeft, bubbleTop);
        this.scrollDiv.appendChild(bubbleDiv);
        if (this.diagCharPort || true) {
            this.statusMessage("render", `&nbsp ${Date.now() - clk}ms`);
        }
        if (this.diagCharPort) {
            this.statusMessage("diagCharPort",
                `&nbsp sp: (${this.topChar}) ep: ${this.viewportEndPos} cp: ${this.cursor.pos}`);
        }
    }

    public loadFinished(clockStart = 0) {
        this.render(0, true);
        if (clockStart > 0) {
            // tslint:disable-next-line:max-line-length
            console.log(`time to edit/impression: ${this.timeToEdit} time to load: ${Date.now() - clockStart}ms len: ${this.sharedString.client.getLength()} - ${performanceNow()}`);
        }
        // this.testWordInfo();
    }

    public randomWordMove() {
        let client = this.sharedString.client;
        let word1 = SharedString.findRandomWord(client.mergeTree, client.getClientId());
        if (word1) {
            let removeStart = word1.pos;
            let removeEnd = removeStart + word1.text.length;
            this.sharedString.removeText(removeStart, removeEnd);
            let word2 = SharedString.findRandomWord(client.mergeTree, client.getClientId());
            while (!word2) {
                word2 = SharedString.findRandomWord(client.mergeTree, client.getClientId());
            }
            let pos = word2.pos + word2.text.length;
            this.sharedString.insertText(word1.text, pos);
        }
    }

    public randomWordMoveStart() {
        this.randWordTimer = setInterval(() => {
            for (let i = 0; i < 3; i++) {
                this.randomWordMove();
            }
        }, 10);
    }

    public randomWordMoveEnd() {
        clearInterval(this.randWordTimer);
    }

    public localQueueRender(updatePos: number) {
        this.updatePGInfo(updatePos);
        this.pendingRender = true;
        window.requestAnimationFrame(() => {
            this.pendingRender = false;
            this.render(this.topChar, true);
        });
    }

    public trackInsights(insights: API.IMap) {
        this.updateInsights(insights);
        insights.on("valueChanged", () => {
            this.updateInsights(insights);
        });
    }

    public updatePGInfo(changePos: number) {
        let tileMarker = <IParagraphMarker>findContainingTile(this.client, changePos, "pg");
        if (tileMarker) {
            tileMarker.cache = undefined;
        }
    }

    // TODO: paragraph spanning changes and annotations
    private applyOp(delta: SharedString.IMergeTreeOp) {
        if (delta.type === SharedString.MergeTreeDeltaType.INSERT) {
            if (delta.marker) {
                this.updatePGInfo(delta.pos1 - 1);
            } else if (delta.pos1 <= this.cursor.pos) {
                this.cursor.pos += delta.text.length;
            }
            this.updatePGInfo(delta.pos1);
        } else if (delta.type === SharedString.MergeTreeDeltaType.REMOVE) {
            if (delta.pos2 <= this.cursor.pos) {
                this.cursor.pos -= (delta.pos2 - delta.pos1);
            } else if (this.cursor.pos >= delta.pos1) {
                this.cursor.pos = delta.pos1;
            }
            this.updatePGInfo(delta.pos1);
        } else if (delta.type === SharedString.MergeTreeDeltaType.GROUP) {
            for (let groupOp of delta.ops) {
                this.applyOp(groupOp);
            }
        }
    }

    private queueRender(msg: API.ISequencedObjectMessage) {
        if ((!this.pendingRender) && msg && msg.contents) {
            this.pendingRender = true;
            window.requestAnimationFrame(() => {
                this.pendingRender = false;
                if (msg.clientId !== this.client.longClientId) {
                    let delta = <SharedString.IMergeTreeOp>msg.contents;
                    this.applyOp(delta);
                }
                this.render(this.topChar, true);
            });
        }
    }

    private async updateInsights(insights: API.IMap) {
        const view = await insights.getView();

        if (view.has("ResumeAnalytics")) {
            const resume = view.get("ResumeAnalytics");
            const probability = parseFloat(resume.resumeAnalyticsResult);
            if (probability !== 1 && probability > 0.7) {
                this.flowContainer.status.overlay(`${Math.round(probability * 100)}% sure I found a resume!`);
            }
        }

        if (view.has("TextAnalytics")) {
            const analytics = view.get("TextAnalytics");
            if (analytics.language) {
                this.statusMessage("li", analytics.language);
            }

            if (analytics.sentiment) {
                const sentimentEmoji = analytics.sentiment > 0.7
                    ? "🙂"
                    : analytics.sentiment < 0.3 ? "🙁" : "😐";
                this.statusMessage("si", sentimentEmoji);
            }
        }
    }
}
