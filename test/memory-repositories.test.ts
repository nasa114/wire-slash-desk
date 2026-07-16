import { runFeedRepositoryContract } from './contract/feed-repository.contract.ts';
import { runArticleRepositoryContract } from './contract/article-repository.contract.ts';
import { createMemoryRepositories } from '../src/repo/memory/index.ts';

const makeRepos = async () => createMemoryRepositories();

runFeedRepositoryContract('memory', makeRepos);
runArticleRepositoryContract('memory', makeRepos);
