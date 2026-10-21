import React, { Fragment } from 'react';
import autoBindReact from 'auto-bind/react';
import VirtualizedList from './VirtualizedList';
import DirectoryLink from './DirectoryLink';
import bytes from 'bytes';
import FavoriteButton from './FavoriteButton';
import trimEnd from 'lodash/trimEnd';
import { pathJoin } from '../util';


export default class Browse extends React.PureComponent {
  constructor(props) {
    super(props);
    autoBindReact(this);
  }

  componentDidMount() {
    this.navigate();
  }

  componentDidUpdate(prevProps, prevState) {
    this.navigate();
  }

  handleShufflePlay() {
    this.props.handleShufflePlay(this.props.browsePath);
  }

  navigate() {
    const {
      browsePath,
      listing,
      fetchDirectory,
    } = this.props;
    if (!listing) {
      fetchDirectory(browsePath);
    }
  }

  render() {
    const {
      listing,
      browsePath,
      playContext,
      history,
    } = this.props;

    const urlParams = new URLSearchParams(window.location.search);
    urlParams.delete('q');
    const search = urlParams.toString();
    // Check if previous page url is the parent directory of current page url.
    const prevPath = trimEnd(history.location.state?.prevPathname, '/');
    const currPath = trimEnd(window.location.pathname, '/');
    const prevPageIsParentDir = prevPath === currPath.slice(0, currPath.lastIndexOf('/'));

    const BrowseRow = (props) => {
      const { item, onPlay } = props;
      item.isBackLink = item.name === '..' && prevPageIsParentDir;

      if (item.type === 'directory') {
        return (
          <>
            <div className="BrowseList-colName">
              <DirectoryLink to={item.href} search={search}
                             isBackLink={item.isBackLink}>{item.name}</DirectoryLink>
            </div>
            <div className="BrowseList-colDir">
              &lt;DIR&gt;
            </div>
            <div className="BrowseList-colCount" title={`Contains ${item.count} direct child items`}>
              {item.count}
            </div>
            <div className="BrowseList-colMtime">
              {item.mtime}
            </div>
            <div className="BrowseList-colSize" title={`Directory size is ${item.size} bytes (recursive)`}>
              {item.size != null && bytes(item.size, { unitSeparator: ' ' })}
            </div>
          </>
        );
      } else {
        return (
          <>
            <div className="BrowseList-colName">
              <FavoriteButton item={item}/>
              <a onClick={onPlay}
                 href={item.url}
                 tabIndex="-1">
                {item.name}
              </a>
            </div>
            <div className="BrowseList-colMtime">
              {item.mtime}
            </div>
            <div className="BrowseList-colSize">
              {bytes(item.size, { unitSeparator: ' ' })}
            </div>
          </>
        );
      }
    }

    return (
      <VirtualizedList
        scrollContainerRef={this.props.scrollContainerRef}
        currContext={this.props.currContext}
        currIdx={this.props.currIdx}
        onSongClick={this.props.onSongClick}
        itemList={listing || []}
        songContext={playContext}
        rowRenderer={BrowseRow}
        listRef={this.props.listRef}
        isSorted={true}
      >
        <h3 className="Browse-topRow">
          {/* Breadcrumb: every segment is a link back up the tree.
              The path used to be plain text, so climbing two levels meant
              hitting '..' twice — or editing the URL. */}
          <span className="Browse-crumbs">
            <DirectoryLink to="/browse" search={search} plain>/</DirectoryLink>
            {browsePath.split('/').filter(Boolean).map((segment, i, segments) => (
              // The separator goes BEFORE each segment, not after. Trailing
              // separators left the root glued to the first folder —
              // "/GBA / Country" instead of "/ GBA / Country" — because the
              // root carries its own slash and so got no separator of its own.
              <Fragment key={i}>
                {i === 0 ? ' ' : ' / '}
                <DirectoryLink
                  to={pathJoin('/browse', segments.slice(0, i + 1).join('/'))}
                  search={search} plain>{segment}</DirectoryLink>
              </Fragment>
            ))}
          </span>{' '}
          <button
            className="box-button"
            title="Shuffle this directory (and all subdirectories)"
            onClick={this.handleShufflePlay}>
            Shuffle Play
          </button>
        </h3>
      </VirtualizedList>
    );
  }
}
